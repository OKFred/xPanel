import {
  EXECUTION_PROTOCOL_VERSION,
  executionCommandResultV1Schema,
  requestSpecV1Schema,
  type ExecutionCommandResultV1,
  type ExecutionEventV1,
  type ExecutionProgressV1,
  type ExecutionSummaryV1,
  type FileReferenceV1,
  type RequestSpecV1,
} from "@xpanel/contracts";

import { executeRequestStream, cancelRequest } from "./execute";
import { bindFile, unbindFile } from "./file-bindings";
import { ExecutionProcessorClient } from "./execution-processor-client";
import {
  failExecution,
  loadExecutionFiles,
  loadExecutionPayload,
  markExecutionRunning,
  updateExecutionProgress,
} from "./execution-repository";
import { markRunningExecutionsOrphaned } from "./execution-recovery";
import {
  eventEnvelope,
  executionDispatchEnvelopeSchema,
} from "./execution-messages";
import { getRelayToken, loadRelayProfiles } from "./remote-profiles";

interface ActiveJob {
  payloadHandle: string;
  cancelRequested: boolean;
  terminal: boolean;
  lastProgressAt: number;
  lastPhase?: ExecutionProgressV1["phase"];
  lastProgress?: ExecutionProgressV1;
  progressChain: Promise<void>;
}

const MAX_CONCURRENT_EXECUTIONS = 4;
const PROGRESS_INTERVAL_MS = 100;

function scopedFileReferenceId(
  executionId: string,
  referenceId: string,
): string {
  return `${executionId}:${referenceId}`;
}

function scopeFileReference(
  reference: FileReferenceV1,
  executionId: string,
): FileReferenceV1 {
  return {
    ...reference,
    id: scopedFileReferenceId(executionId, reference.id),
  };
}

export function scopeExecutionFileReferences(
  request: RequestSpecV1,
  executionId: string,
): RequestSpecV1 {
  if (request.body.kind === "file") {
    return {
      ...request,
      body: {
        ...request.body,
        file: scopeFileReference(request.body.file, executionId),
      },
    };
  }
  if (request.body.kind !== "multipart") return request;
  return {
    ...request,
    body: {
      ...request.body,
      parts: request.body.parts.map((part) =>
        part.kind === "file"
          ? { ...part, file: scopeFileReference(part.file, executionId) }
          : part,
      ),
    },
  };
}

function commandResult(
  commandId: string,
  accepted: boolean,
  error?: { code: string; message: string },
): ExecutionCommandResultV1 {
  return executionCommandResultV1Schema.parse({
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    commandId,
    accepted,
    ...(error ? { error } : {}),
  });
}

function eventForSummary(summary: ExecutionSummaryV1): ExecutionEventV1 {
  if (summary.state === "succeeded" && summary.responseHandle) {
    return {
      protocolVersion: EXECUTION_PROTOCOL_VERSION,
      eventId: crypto.randomUUID(),
      type: "execution.completed",
      execution: {
        ...summary,
        state: "succeeded",
        responseHandle: summary.responseHandle,
      },
    };
  }
  if (
    (summary.state === "failed" ||
      summary.state === "cancelled" ||
      summary.state === "orphaned") &&
    summary.error
  ) {
    return {
      protocolVersion: EXECUTION_PROTOCOL_VERSION,
      eventId: crypto.randomUUID(),
      type: "execution.failed",
      execution: { ...summary, state: summary.state, error: summary.error },
    };
  }
  return {
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    eventId: crypto.randomUUID(),
    type: "execution.progress",
    execution: summary,
  };
}

async function broadcast(summary: ExecutionSummaryV1): Promise<void> {
  try {
    await chrome.runtime.sendMessage(eventEnvelope(eventForSummary(summary)));
  } catch {
    // IndexedDB remains the source of truth when no UI is connected.
  }
}

function mediaType(headers: ExecutionSummaryResponse["headers"]): string {
  return (
    headers
      .find((header) => header.name.toLowerCase() === "content-type")
      ?.value.split(";")[0]
      ?.trim() ?? ""
  );
}

function isTextMediaType(value: string): boolean {
  return (
    value.startsWith("text/") ||
    value.includes("json") ||
    value.includes("xml") ||
    value.includes("javascript") ||
    value.includes("yaml")
  );
}

type ExecutionSummaryResponse = Awaited<
  ReturnType<typeof executeRequestStream>
>;

function failureDetails(error: unknown, cancelled: boolean) {
  const message = error instanceof Error ? error.message : "Request failed.";
  if (
    cancelled ||
    (error instanceof DOMException && error.name === "AbortError")
  ) {
    const timeout = message.toLowerCase().includes("timed out");
    return {
      state: timeout ? ("failed" as const) : ("cancelled" as const),
      error: {
        code: timeout ? "timeout" : "cancelled",
        message: timeout ? "Request timed out." : "Request cancelled.",
      },
    };
  }
  const tooLarge =
    message.toLowerCase().includes("exceeds") && message.includes("limit");
  return {
    state: "failed" as const,
    error: {
      code: tooLarge ? "response_too_large" : "execution_failed",
      message,
    },
  };
}

export class OffscreenExecutionCoordinator {
  private readonly jobs = new Map<string, ActiveJob>();
  private readonly processor = new ExecutionProcessorClient();

  async start(
    command: Extract<
      typeof executionDispatchEnvelopeSchema._output.command,
      { type: "execution.start" }
    >,
  ): Promise<ExecutionCommandResultV1> {
    if (this.jobs.has(command.executionId)) {
      return commandResult(command.commandId, false, {
        code: "already_running",
        message: "This execution is already running.",
      });
    }
    if (this.jobs.size >= MAX_CONCURRENT_EXECUTIONS) {
      return commandResult(command.commandId, false, {
        code: "concurrency_limit",
        message: `xPanel allows at most ${MAX_CONCURRENT_EXECUTIONS} background executions.`,
      });
    }
    const payload = await loadExecutionPayload(command.payloadHandle);
    if (!payload || payload.executionId !== command.executionId) {
      return commandResult(command.commandId, false, {
        code: "invalid_payload",
        message: "The staged execution payload is missing or mismatched.",
      });
    }
    const job: ActiveJob = {
      payloadHandle: command.payloadHandle,
      cancelRequested: false,
      terminal: false,
      lastProgressAt: 0,
      progressChain: Promise.resolve(),
    };
    this.jobs.set(command.executionId, job);
    const running = await markExecutionRunning(command.executionId);
    await broadcast(running);
    void this.run(command.executionId, job);
    return commandResult(command.commandId, true);
  }

  async cancel(
    command: Extract<
      typeof executionDispatchEnvelopeSchema._output.command,
      { type: "execution.cancel" }
    >,
  ): Promise<ExecutionCommandResultV1> {
    const job = this.jobs.get(command.executionId);
    if (!job || job.terminal) {
      return commandResult(command.commandId, false, {
        code: "not_running",
        message: "The execution is not running.",
      });
    }
    job.cancelRequested = true;
    cancelRequest(command.executionId);
    const cancelling = await updateExecutionProgress(command.executionId, {
      phase: "cancelling",
      loadedBytes: job.lastProgress?.loadedBytes ?? 0,
      ...(job.lastProgress?.totalBytes === undefined
        ? {}
        : { totalBytes: job.lastProgress.totalBytes }),
      elapsedMs: job.lastProgress?.elapsedMs ?? 0,
    });
    await broadcast(cancelling);
    job.terminal = true;
    const cancelled = await failExecution(
      command.executionId,
      job.payloadHandle,
      "cancelled",
      { code: "cancelled", message: "Request cancelled." },
    );
    await broadcast(cancelled);
    return commandResult(command.commandId, true);
  }

  private reportProgress(
    executionId: string,
    job: ActiveJob,
    progress: ExecutionProgressV1,
  ): void {
    if (job.terminal) return;
    const now = performance.now();
    const phaseChanged = job.lastPhase !== progress.phase;
    if (!phaseChanged && now - job.lastProgressAt < PROGRESS_INTERVAL_MS)
      return;
    job.lastProgressAt = now;
    job.lastPhase = progress.phase;
    job.lastProgress = progress;
    job.progressChain = job.progressChain
      .then(async () => {
        if (job.terminal) return;
        await broadcast(await updateExecutionProgress(executionId, progress));
      })
      .catch(() => undefined);
  }

  private async run(executionId: string, job: ActiveJob): Promise<void> {
    let processorJob:
      | Awaited<ReturnType<ExecutionProcessorClient["begin"]>>
      | undefined;
    let fileReferenceIds: string[] = [];
    let responseStream: ReadableStream<Uint8Array> | undefined;
    try {
      const payload = await loadExecutionPayload(job.payloadHandle);
      if (!payload) throw new Error("The staged execution payload is missing.");
      const files = await loadExecutionFiles(job.payloadHandle);
      fileReferenceIds = files.map((file) =>
        scopedFileReferenceId(executionId, file.referenceId),
      );
      for (const stored of files) {
        const scopedReferenceId = scopedFileReferenceId(
          executionId,
          stored.referenceId,
        );
        bindFile(
          {
            id: scopedReferenceId,
            name: stored.name,
            size: stored.blob.size,
            ...(stored.mediaType ? { mediaType: stored.mediaType } : {}),
            requiresReselection: false,
          },
          new File([stored.blob], stored.name, {
            type: stored.mediaType,
            lastModified: stored.lastModified,
          }),
        );
      }
      if (job.cancelRequested)
        throw new DOMException("Request cancelled.", "AbortError");
      const request = requestSpecV1Schema.parse({
        ...scopeExecutionFileReferences(payload.request, executionId),
        id: executionId,
      });
      let target;
      if (payload.target.kind === "browser") {
        target = { kind: "browser" as const };
      } else {
        const profileId = payload.target.profileId;
        const profile = (await loadRelayProfiles()).find(
          (candidate) => candidate.id === profileId,
        );
        if (!profile)
          throw new Error("The Remote relay profile no longer exists.");
        const token = await getRelayToken(profile);
        if (!token) throw new Error("The Remote relay token is unavailable.");
        target = { kind: "remote" as const, profile, token };
      }
      const response = await executeRequestStream(request, {
        target,
        browserPermissionPreflighted: true,
        relayPermissionPreflighted: true,
        maximumResponseBytes: payload.responseLimitBytes,
        onProgress: (progress) =>
          this.reportProgress(executionId, job, progress),
      });
      responseStream = response.stream;
      const contentType = mediaType(response.headers);
      const maximumBytes = Math.min(
        payload.responseLimitBytes,
        response.maximumResponseBytes ?? payload.responseLimitBytes,
      );
      processorJob = await this.processor.begin({
        jobId: executionId,
        executionId,
        payloadHandle: job.payloadHandle,
        response: {
          requestId: payload.request.id,
          executor: response.executor,
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
          timings: response.timings,
          redirects: response.redirects,
          warnings: response.warnings,
        },
        encoding: isTextMediaType(contentType) ? "utf8" : "base64",
        ...(contentType ? { mediaType: contentType } : {}),
        maximumBytes,
      });
      const reader = responseStream.getReader();
      let sequence = 0;
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          await processorJob.push(result.value, sequence);
          sequence += 1;
        }
      } catch (error) {
        try {
          await reader.cancel(error);
        } catch {
          // Preserve the original stream/processor failure.
        }
        throw error;
      } finally {
        reader.releaseLock();
      }
      await job.progressChain;
      if (job.cancelRequested) {
        throw new DOMException("Request cancelled.", "AbortError");
      }
      const summary = await processorJob.finish(response.timings.durationMs);
      job.terminal = true;
      await broadcast(summary);
    } catch (error) {
      try {
        await responseStream?.cancel(error);
      } catch {
        // The reader path already cancels locked streams.
      }
      await processorJob?.cancel();
      await job.progressChain;
      const failure = failureDetails(error, job.cancelRequested);
      const summary = await failExecution(
        executionId,
        job.payloadHandle,
        failure.state,
        failure.error,
      );
      job.terminal = true;
      await broadcast(summary);
    } finally {
      for (const referenceId of fileReferenceIds) unbindFile(referenceId);
      this.jobs.delete(executionId);
    }
  }
}

export function installOffscreenMessageListener(
  coordinator: OffscreenExecutionCoordinator,
  initialized: Promise<void>,
): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    const parsed = executionDispatchEnvelopeSchema.safeParse(message);
    if (!parsed.success) return false;
    const response = initialized.then(() =>
      parsed.data.command.type === "execution.start"
        ? coordinator.start(parsed.data.command)
        : coordinator.cancel(parsed.data.command),
    );
    void response.then(sendResponse, (error: unknown) => {
      sendResponse(
        commandResult(parsed.data.command.commandId, false, {
          code: "offscreen_error",
          message:
            error instanceof Error
              ? error.message
              : "Offscreen command failed.",
        }),
      );
    });
    return true;
  });
}

export function startOffscreenExecution(): void {
  const coordinator = new OffscreenExecutionCoordinator();
  const initialized = (async () => {
    const orphaned = await markRunningExecutionsOrphaned();
    for (const summary of orphaned) await broadcast(summary);
  })();
  void initialized.catch(() => undefined);
  installOffscreenMessageListener(coordinator, initialized);
}
