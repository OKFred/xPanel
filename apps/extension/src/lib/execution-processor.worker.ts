import { completeStreamedExecution } from "./execution-completion";
import {
  processorInputSchema,
  processorOutputSchema,
  type ProcessorOutput,
} from "./execution-processor-protocol";
import type { ResponseMetadataV1 } from "./execution-response-store";

interface ProcessorJob {
  executionId: string;
  payloadHandle: string;
  response: ResponseMetadataV1;
  encoding: "utf8" | "base64";
  mediaType?: string;
  maximumBytes: number;
  chunks: ArrayBuffer[];
  sizeBytes: number;
  nextSequence: number;
}

export interface WorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown): void;
}

let workerScope: WorkerScope;
const jobs = new Map<string, ProcessorJob>();
const AUTO_PRETTY_LIMIT = 1024 * 1024;

function post(output: ProcessorOutput): void {
  workerScope.postMessage(processorOutputSchema.parse(output));
}

function textMediaType(mediaType = ""): boolean {
  return (
    mediaType.startsWith("text/") ||
    mediaType.includes("json") ||
    mediaType.includes("xml") ||
    mediaType.includes("javascript") ||
    mediaType.includes("yaml")
  );
}

function lineStatistics(text: string): {
  lineCount: number;
  maxLineLength: number;
} {
  let lineCount = 1;
  let currentLength = 0;
  let maxLineLength = 0;
  for (const character of text) {
    if (character === "\n") {
      lineCount += 1;
      maxLineLength = Math.max(maxLineLength, currentLength);
      currentLength = 0;
    } else {
      currentLength += 1;
    }
  }
  return {
    lineCount,
    maxLineLength: Math.max(maxLineLength, currentLength),
  };
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function finish(jobId: string, durationMs: number): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) throw new Error("Processor job was not found.");
  const blob = new Blob(job.chunks, {
    type: job.mediaType ?? "application/octet-stream",
  });
  const sha256 = hex(
    await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
  );
  let prettyBlob: Blob | undefined;
  let presentation:
    | { lineCount: number; maxLineLength: number; prettyAvailable: boolean }
    | undefined;
  if (job.encoding === "utf8" && textMediaType(job.mediaType)) {
    const text = await blob.text();
    const stats = lineStatistics(text);
    if (job.sizeBytes <= AUTO_PRETTY_LIMIT && job.mediaType?.includes("json")) {
      try {
        const pretty = JSON.stringify(JSON.parse(text), null, 2);
        prettyBlob = new Blob([pretty], { type: "application/json" });
      } catch {
        // Invalid JSON remains available as raw text.
      }
    }
    presentation = { ...stats, prettyAvailable: prettyBlob !== undefined };
  }
  const execution = await completeStreamedExecution({
    executionId: job.executionId,
    payloadHandle: job.payloadHandle,
    response: {
      ...job.response,
      timings: { ...job.response.timings, durationMs },
    },
    body: {
      kind: "stored",
      encoding: job.encoding,
      ...(job.mediaType ? { mediaType: job.mediaType } : {}),
      sizeBytes: job.sizeBytes,
      sha256,
    },
    blob,
    ...(prettyBlob ? { prettyBlob } : {}),
    ...(presentation ? { presentation } : {}),
  });
  jobs.delete(jobId);
  post({ type: "processor.complete", jobId, execution });
}

function handleMessage(event: MessageEvent<unknown>): void {
  const parsed = processorInputSchema.safeParse(event.data);
  if (!parsed.success) {
    const jobId =
      typeof event.data === "object" &&
      event.data !== null &&
      "jobId" in event.data &&
      typeof event.data.jobId === "string"
        ? event.data.jobId
        : undefined;
    if (jobId) {
      post({
        type: "processor.error",
        jobId,
        error: {
          code: "invalid_message",
          message: "Response processor message validation failed.",
        },
      });
    }
    return;
  }
  const message = parsed.data;
  if (message.type === "processor.begin") {
    if (jobs.has(message.jobId)) {
      post({
        type: "processor.error",
        jobId: message.jobId,
        error: {
          code: "duplicate_job",
          message: "Response processor job already exists.",
        },
      });
      return;
    }
    jobs.set(message.jobId, {
      executionId: message.executionId,
      payloadHandle: message.payloadHandle,
      response: message.response,
      encoding: message.encoding,
      ...(message.mediaType ? { mediaType: message.mediaType } : {}),
      maximumBytes: message.maximumBytes,
      chunks: [],
      sizeBytes: 0,
      nextSequence: 0,
    });
    post({ type: "processor.ready", jobId: message.jobId });
    return;
  }
  const job = jobs.get(message.jobId);
  if (!job) {
    post({
      type: "processor.error",
      jobId: message.jobId,
      error: {
        code: "unknown_job",
        message: "Response processor job was not found.",
      },
    });
    return;
  }
  if (message.type === "processor.chunk") {
    if (message.sequence !== job.nextSequence) {
      jobs.delete(message.jobId);
      post({
        type: "processor.error",
        jobId: message.jobId,
        error: {
          code: "invalid_chunk",
          message: "Response chunk sequence is invalid.",
        },
      });
      return;
    }
    job.sizeBytes += message.chunk.byteLength;
    if (job.sizeBytes > job.maximumBytes) {
      jobs.delete(message.jobId);
      post({
        type: "processor.error",
        jobId: message.jobId,
        error: {
          code: "response_too_large",
          message: "Response body exceeds the configured capture limit.",
        },
      });
      return;
    }
    job.chunks.push(message.chunk);
    job.nextSequence += 1;
    post({
      type: "processor.chunk-ack",
      jobId: message.jobId,
      sequence: message.sequence,
    });
    return;
  }
  if (message.type === "processor.cancel") {
    jobs.delete(message.jobId);
    post({ type: "processor.cancelled", jobId: message.jobId });
    return;
  }
  void finish(message.jobId, message.durationMs).catch((error: unknown) => {
    jobs.delete(message.jobId);
    post({
      type: "processor.error",
      jobId: message.jobId,
      error: {
        code: "processing_failed",
        message:
          error instanceof Error
            ? error.message
            : "Response processing failed.",
      },
    });
  });
}

export function startExecutionProcessor(
  scope = globalThis as unknown as WorkerScope,
): void {
  workerScope = scope;
  workerScope.onmessage = handleMessage;
}
