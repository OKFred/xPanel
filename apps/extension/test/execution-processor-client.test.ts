import { afterEach, describe, expect, it, vi } from "vitest";

import { ExecutionProcessorClient } from "../src/lib/execution-processor-client";
import type {
  ProcessorInput,
  ProcessorOutput,
} from "../src/lib/execution-processor-protocol";

type ProcessorBeginInput = Omit<
  Extract<ProcessorInput, { type: "processor.begin" }>,
  "type"
>;

class ControlledWorker {
  readonly posts: ProcessorInput[] = [];
  terminated = false;
  private readonly messageListeners: ((
    event: MessageEvent<unknown>,
  ) => void)[] = [];
  private readonly errorListeners: ((event: ErrorEvent) => void)[] = [];

  constructor(private readonly readyOnBegin = false) {}

  addEventListener(type: string, listener: EventListener): void {
    if (type === "message") {
      this.messageListeners.push(
        listener as (event: MessageEvent<unknown>) => void,
      );
    } else if (type === "error") {
      this.errorListeners.push(listener as (event: ErrorEvent) => void);
    }
  }

  postMessage(message: ProcessorInput): void {
    this.posts.push(message);
    if (this.readyOnBegin && message.type === "processor.begin") {
      this.emit({ type: "processor.ready", jobId: message.jobId });
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  crash(message: string): void {
    const event = new ErrorEvent("error", { message });
    for (const listener of this.errorListeners) listener(event);
  }

  private emit(output: ProcessorOutput): void {
    const event = new MessageEvent("message", { data: output });
    for (const listener of this.messageListeners) listener(event);
  }
}

function beginInput(jobId: string): ProcessorBeginInput {
  return {
    jobId,
    executionId: jobId,
    payloadHandle: `payload-${jobId}`,
    response: {
      requestId: `request-${jobId}`,
      executor: "browser",
      status: 200,
      statusText: "OK",
      headers: [],
      timings: {
        startedAt: "2026-09-06T00:00:00.000Z",
        durationMs: 1,
      },
      redirects: [],
      warnings: [],
    },
    encoding: "utf8",
    mediaType: "application/json",
    maximumBytes: 20 * 1024 * 1024,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ExecutionProcessorClient worker liveness", () => {
  it("discards a crashed worker and lazily creates a replacement", async () => {
    const first = new ControlledWorker(true);
    const replacement = new ControlledWorker(true);
    const workers = [first, replacement];
    let creations = 0;
    const client = new ExecutionProcessorClient(() => {
      const worker = workers[creations++];
      if (!worker) throw new Error("Unexpected worker creation.");
      return worker as unknown as Worker;
    });

    expect(creations).toBe(0);
    const crashedJob = await client.begin(beginInput("execution-crashed"));
    expect(creations).toBe(1);

    first.crash("processor boom");
    expect(first.terminated).toBe(true);
    await expect(crashedJob.finish(1)).rejects.toThrow(
      "Processor job execution-crashed was not found.",
    );

    await expect(
      client.begin(beginInput("execution-recovered")),
    ).resolves.toBeDefined();
    expect(creations).toBe(2);
    expect(replacement.posts).toContainEqual(
      expect.objectContaining({
        type: "processor.begin",
        jobId: "execution-recovered",
      }),
    );

    client.close();
  });

  it("times out a stalled startup and permits a later replacement", async () => {
    vi.useFakeTimers();
    const stalled = new ControlledWorker(false);
    const replacement = new ControlledWorker(true);
    const workers = [stalled, replacement];
    const client = new ExecutionProcessorClient(
      () => {
        const worker = workers.shift();
        if (!worker) throw new Error("Unexpected worker creation.");
        return worker as unknown as Worker;
      },
      { stageTimeoutMs: 10 },
    );

    const pending = client.begin(beginInput("execution-stalled"));
    const rejection = expect(pending).rejects.toThrow(
      "Response processor startup timed out.",
    );
    await vi.advanceTimersByTimeAsync(11);
    await rejection;
    expect(stalled.terminated).toBe(true);

    await expect(
      client.begin(beginInput("execution-after-timeout")),
    ).resolves.toBeDefined();
    expect(replacement.posts).toHaveLength(1);

    client.close();
  });
});
