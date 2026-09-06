import type { ExecutionSummaryV1 } from "@xpanel/contracts";

import {
  processorInputSchema,
  processorOutputSchema,
  type ProcessorInput,
  type ProcessorOutput,
} from "./execution-processor-protocol";

const DEFAULT_STAGE_TIMEOUT_MS = 30_000;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface ProcessorJobState {
  worker: Worker;
  ready: Deferred<void>;
  complete: Deferred<ExecutionSummaryV1>;
  chunkAcks: Map<number, Deferred<void>>;
}

export interface ExecutionProcessorClientOptions {
  stageTimeoutMs?: number;
}

export type ExecutionProcessorWorkerFactory = () => Worker;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function defaultWorkerFactory(): Worker {
  return new Worker(chrome.runtime.getURL("execution-processor.js"), {
    type: "module",
  });
}

function processorError(
  output: Extract<ProcessorOutput, { type: "processor.error" }>,
) {
  return new Error(output.error.message, { cause: output.error.code });
}

function normalizeError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback, { cause: value });
}

function waitWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(normalizeError(error, "Response processor failed."));
      },
    );
  });
}

export interface ProcessorJob {
  push(chunk: Uint8Array, sequence: number): Promise<void>;
  finish(durationMs: number): Promise<ExecutionSummaryV1>;
  cancel(): Promise<void>;
}

export class ExecutionProcessorClient {
  private worker: Worker | undefined;
  private readonly workerFactory: ExecutionProcessorWorkerFactory;
  private readonly stageTimeoutMs: number;
  private readonly jobs = new Map<string, ProcessorJobState>();
  private closed = false;

  constructor(
    workerOrFactory:
      | Worker
      | ExecutionProcessorWorkerFactory = defaultWorkerFactory,
    options: ExecutionProcessorClientOptions = {},
  ) {
    const timeout = options.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new Error("Response processor stage timeout must be positive.");
    }
    this.stageTimeoutMs = timeout;

    if (typeof workerOrFactory === "function") {
      this.workerFactory = workerOrFactory;
      return;
    }

    this.workerFactory = () => {
      throw new Error(
        "Response processor cannot restart without a replacement worker factory.",
      );
    };
    this.attachWorker(workerOrFactory);
  }

  async begin(
    input: Omit<Extract<ProcessorInput, { type: "processor.begin" }>, "type">,
  ): Promise<ProcessorJob> {
    if (this.closed) throw new Error("Response processor is closed.");
    if (this.jobs.has(input.jobId)) {
      throw new Error(`Processor job ${input.jobId} already exists.`);
    }

    const worker = this.ensureWorker();
    const state: ProcessorJobState = {
      worker,
      ready: deferred<void>(),
      complete: deferred<ExecutionSummaryV1>(),
      chunkAcks: new Map(),
    };
    void state.complete.promise.catch(() => undefined);
    this.jobs.set(input.jobId, state);

    try {
      this.post(worker, { type: "processor.begin", ...input });
      await this.waitForStage(
        input.jobId,
        state,
        state.ready.promise,
        "startup",
      );
    } catch (error) {
      this.invalidateIfCurrentJob(input.jobId, state, error);
      throw error;
    }

    return {
      push: async (chunk, sequence) => {
        const current = this.requireJob(input.jobId, state);
        if (current.chunkAcks.has(sequence)) {
          throw new Error(
            `Processor chunk ${sequence} for ${input.jobId} is already pending.`,
          );
        }
        const ack = deferred<void>();
        current.chunkAcks.set(sequence, ack);
        const buffer = chunk.slice().buffer;
        try {
          this.post(
            current.worker,
            {
              type: "processor.chunk",
              jobId: input.jobId,
              sequence,
              chunk: buffer,
            },
            [buffer],
          );
          await this.waitForStage(
            input.jobId,
            state,
            ack.promise,
            `chunk ${sequence} acknowledgement`,
          );
        } catch (error) {
          this.invalidateIfCurrentJob(input.jobId, state, error);
          throw error;
        }
      },
      finish: async (durationMs) => {
        const current = this.requireJob(input.jobId, state);
        try {
          this.post(current.worker, {
            type: "processor.finish",
            jobId: input.jobId,
            durationMs,
          });
          return await this.waitForStage(
            input.jobId,
            state,
            state.complete.promise,
            "completion",
          );
        } catch (error) {
          this.invalidateIfCurrentJob(input.jobId, state, error);
          throw error;
        }
      },
      cancel: async () => {
        const current = this.jobs.get(input.jobId);
        if (current !== state) return;
        try {
          this.post(current.worker, {
            type: "processor.cancel",
            jobId: input.jobId,
          });
          await this.waitForStage(
            input.jobId,
            state,
            state.complete.promise,
            "cancellation",
          );
        } catch (error) {
          this.invalidateIfCurrentJob(input.jobId, state, error);
          // Cancellation intentionally absorbs the terminal rejection.
        }
      },
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.invalidateWorker(this.worker, new Error("Response processor closed."));
  }

  private ensureWorker(): Worker {
    if (this.closed) throw new Error("Response processor is closed.");
    if (this.worker) return this.worker;
    const worker = this.workerFactory();
    this.attachWorker(worker);
    return worker;
  }

  private attachWorker(worker: Worker): void {
    this.worker = worker;
    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (this.worker === worker) this.handleMessage(event.data);
    });
    worker.addEventListener("error", (event: ErrorEvent) => {
      this.invalidateWorker(
        worker,
        new Error(event.message || "Response processor crashed."),
      );
    });
    worker.addEventListener("messageerror", () => {
      this.invalidateWorker(
        worker,
        new Error("Response processor message deserialization failed."),
      );
    });
  }

  private post(
    worker: Worker,
    message: ProcessorInput,
    transfer: Transferable[] = [],
  ): void {
    if (this.worker !== worker) {
      throw new Error("Response processor is unavailable.");
    }
    const validated = processorInputSchema.parse(message);
    worker.postMessage(validated, transfer);
  }

  private requireJob(
    jobId: string,
    expected: ProcessorJobState,
  ): ProcessorJobState {
    const job = this.jobs.get(jobId);
    if (job !== expected) {
      throw new Error(`Processor job ${jobId} was not found.`);
    }
    return job;
  }

  private async waitForStage<T>(
    jobId: string,
    state: ProcessorJobState,
    promise: Promise<T>,
    stage: string,
  ): Promise<T> {
    try {
      return await waitWithTimeout(
        promise,
        this.stageTimeoutMs,
        `Response processor ${stage} timed out.`,
      );
    } catch (error) {
      this.invalidateIfCurrentJob(jobId, state, error);
      throw error;
    }
  }

  private invalidateIfCurrentJob(
    jobId: string,
    state: ProcessorJobState,
    error: unknown,
  ): void {
    if (this.jobs.get(jobId) !== state) return;
    this.invalidateWorker(
      state.worker,
      normalizeError(error, "Response processor failed."),
    );
  }

  private handleMessage(value: unknown): void {
    const parsed = processorOutputSchema.safeParse(value);
    if (!parsed.success) {
      this.invalidateWorker(
        this.worker,
        new Error("Response processor returned an invalid message."),
      );
      return;
    }
    const output = parsed.data;
    const job = this.jobs.get(output.jobId);
    if (!job) return;
    if (output.type === "processor.ready") {
      job.ready.resolve();
      return;
    }
    if (output.type === "processor.chunk-ack") {
      job.chunkAcks.get(output.sequence)?.resolve();
      job.chunkAcks.delete(output.sequence);
      return;
    }
    this.jobs.delete(output.jobId);
    if (output.type === "processor.complete") {
      job.complete.resolve(output.execution);
      return;
    }
    const error =
      output.type === "processor.error"
        ? processorError(output)
        : new DOMException("Response processing cancelled.", "AbortError");
    job.ready.reject(error);
    job.complete.reject(error);
    for (const ack of job.chunkAcks.values()) ack.reject(error);
    job.chunkAcks.clear();
  }

  private invalidateWorker(worker: Worker | undefined, error: Error): void {
    if (worker && this.worker !== worker) return;
    const current = this.worker;
    this.worker = undefined;
    try {
      current?.terminate();
    } finally {
      this.rejectAll(error);
    }
  }

  private rejectAll(error: Error): void {
    for (const job of this.jobs.values()) {
      job.ready.reject(error);
      job.complete.reject(error);
      for (const ack of job.chunkAcks.values()) ack.reject(error);
      job.chunkAcks.clear();
    }
    this.jobs.clear();
  }
}
