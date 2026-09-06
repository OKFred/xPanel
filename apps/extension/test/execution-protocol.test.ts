import { describe, expect, it } from "vitest";

import { createDefaultRequest } from "@xpanel/contracts";

import {
  controlEnvelope,
  executionControlEnvelopeSchema,
  executionEventEnvelopeSchema,
} from "../src/lib/execution-messages";
import { ExecutionProcessorClient } from "../src/lib/execution-processor-client";
import type {
  ProcessorInput,
  ProcessorOutput,
} from "../src/lib/execution-processor-protocol";

class FakeWorker {
  readonly posts: { message: ProcessorInput; transfer: Transferable[] }[] = [];
  private readonly messageListeners: ((
    event: MessageEvent<unknown>,
  ) => void)[] = [];

  addEventListener(type: string, listener: EventListener): void {
    if (type === "message") {
      this.messageListeners.push(
        listener as (event: MessageEvent<unknown>) => void,
      );
    }
  }

  postMessage(message: ProcessorInput, transfer: Transferable[] = []): void {
    this.posts.push({ message, transfer });
    if (message.type === "processor.begin") {
      this.emit({ type: "processor.ready", jobId: message.jobId });
    } else if (message.type === "processor.chunk") {
      this.emit({
        type: "processor.chunk-ack",
        jobId: message.jobId,
        sequence: message.sequence,
      });
    } else if (message.type === "processor.finish") {
      this.emit({
        type: "processor.complete",
        jobId: message.jobId,
        execution: {
          schemaVersion: 1,
          executionId: message.jobId,
          requestId: "request-1",
          executor: "browser",
          state: "succeeded",
          retention: "10m",
          revision: 2,
          progress: {
            phase: "complete",
            loadedBytes: 3,
            totalBytes: 3,
            elapsedMs: message.durationMs,
          },
          responseHandle: "response-1",
          createdAt: "2026-09-06T00:00:00.000Z",
          updatedAt: "2026-09-06T00:00:01.000Z",
          expiresAt: "2026-09-06T00:10:01.000Z",
        },
      });
    }
  }

  terminate(): void {}

  private emit(output: ProcessorOutput): void {
    queueMicrotask(() => {
      for (const listener of this.messageListeners) {
        listener(new MessageEvent("message", { data: output }));
      }
    });
  }
}

describe("execution cross-context protocol", () => {
  it("strictly keeps request bodies out of runtime control envelopes", () => {
    const command = {
      protocolVersion: 1 as const,
      commandId: "command-1",
      type: "execution.start" as const,
      executionId: "execution-1",
      payloadHandle: "payload-1",
    };
    expect(
      executionControlEnvelopeSchema.parse(controlEnvelope(command)),
    ).toEqual(controlEnvelope(command));
    expect(
      executionControlEnvelopeSchema.safeParse({
        ...controlEnvelope(command),
        request: createDefaultRequest(),
      }).success,
    ).toBe(false);
    expect(
      executionEventEnvelopeSchema.safeParse({
        channel: "xpanel.execution.v1",
        recipient: "clients",
        event: {
          protocolVersion: 1,
          eventId: "event-1",
          type: "execution.snapshot",
          executions: [],
        },
        body: "must-not-cross-runtime",
      }).success,
    ).toBe(false);
  });

  it("transfers each response chunk and waits for its acknowledgement", async () => {
    const worker = new FakeWorker();
    const client = new ExecutionProcessorClient(worker as unknown as Worker);
    const job = await client.begin({
      jobId: "execution-1",
      executionId: "execution-1",
      payloadHandle: "payload-1",
      response: {
        requestId: "request-1",
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
    });
    await job.push(new Uint8Array([1, 2, 3]), 0);
    const completed = await job.finish(25);

    const chunkPost = worker.posts.find(
      ({ message }) => message.type === "processor.chunk",
    );
    expect(chunkPost?.transfer).toHaveLength(1);
    expect(chunkPost?.transfer[0]).toBe(
      chunkPost?.message.type === "processor.chunk"
        ? chunkPost.message.chunk
        : undefined,
    );
    expect(completed).toMatchObject({
      executionId: "execution-1",
      state: "succeeded",
      responseHandle: "response-1",
    });
  });
});
