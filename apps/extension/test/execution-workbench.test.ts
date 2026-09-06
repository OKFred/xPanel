import { flushPromises } from "@vue/test-utils";
import { ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ExecutionEventV1,
  ExecutionProgressV1,
  ExecutionSummaryV1,
} from "@xpanel/contracts";
import { createDefaultRequest } from "@xpanel/contracts";

const client = vi.hoisted(() => ({
  cancelBackgroundExecution: vi.fn(),
  clearBackgroundExecutionResults: vi.fn(),
  listExecutionSummaries: vi.fn(),
  loadExecutionPreferences: vi.fn(),
  loadExecutionPrettyBody: vi.fn(),
  loadExecutionResponse: vi.fn(),
  loadExecutionResponseBody: vi.fn(),
  loadExecutionResponseMetadata: vi.fn(),
  persistImportedResponse: vi.fn(),
  saveExecutionPreferences: vi.fn(),
  startBackgroundExecution: vi.fn(),
  subscribeExecutionEvents: vi.fn(),
}));

vi.mock("../src/lib/execution-client", () => client);

import { useExecutionWorkbench } from "../src/composables/useExecutionWorkbench";

let listener: ((event: ExecutionEventV1) => void) | undefined;

function progress(
  phase: ExecutionProgressV1["phase"] = "waiting",
): ExecutionProgressV1 {
  return { phase, loadedBytes: 0, elapsedMs: 5 };
}

function summary(input: {
  executionId: string;
  requestId: string;
  state: ExecutionSummaryV1["state"];
  revision: number;
  responseHandle?: string;
  error?: { code: string; message: string };
  updatedAt?: string;
}): ExecutionSummaryV1 {
  return {
    schemaVersion: 1,
    executionId: input.executionId,
    requestId: input.requestId,
    executor: "browser",
    state: input.state,
    retention: "10m",
    revision: input.revision,
    progress: progress(input.state === "succeeded" ? "complete" : "waiting"),
    ...(input.responseHandle ? { responseHandle: input.responseHandle } : {}),
    ...(input.error ? { error: input.error } : {}),
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-09-06T00:00:01.000Z",
  };
}

function response(requestId: string, executionId: string, handle: string) {
  return {
    schemaVersion: 1 as const,
    handle,
    executionId,
    requestId,
    executor: "browser" as const,
    status: 200,
    statusText: "OK",
    headers: [],
    body: {
      kind: "stored" as const,
      encoding: "utf8" as const,
      mediaType: "application/json",
      sizeBytes: 11,
    },
    timings: {
      startedAt: "2026-09-06T00:00:00.000Z",
      durationMs: 10,
    },
    redirects: [],
    warnings: [],
    createdAt: "2026-09-06T00:00:01.000Z",
  };
}

function createHarness() {
  const busy = ref(false);
  const notice = ref("");
  const errorMessage = ref("");
  return {
    busy,
    notice,
    errorMessage,
    workbench: useExecutionWorkbench({ busy, notice, errorMessage }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listener = undefined;
  client.subscribeExecutionEvents.mockImplementation(
    (candidate: (event: ExecutionEventV1) => void) => {
      listener = candidate;
      return vi.fn();
    },
  );
  client.listExecutionSummaries.mockResolvedValue([]);
  client.loadExecutionPreferences.mockResolvedValue({
    schemaVersion: 1,
    retention: "10m",
    responseLimitBytes: 20 * 1024 * 1024,
  });
  client.loadExecutionPrettyBody.mockResolvedValue(undefined);
  client.loadExecutionResponseBody.mockResolvedValue(
    new Blob(['{"ok":true}'], { type: "application/json" }),
  );
  client.cancelBackgroundExecution.mockResolvedValue(undefined);
  client.clearBackgroundExecutionResults.mockResolvedValue(undefined);
});

describe("execution workbench", () => {
  it("rejects a missing persisted body handle", async () => {
    client.listExecutionSummaries.mockResolvedValue([
      summary({
        executionId: "execution-missing",
        requestId: "request-missing",
        state: "succeeded",
        revision: 2,
        responseHandle: "response-missing",
      }),
    ]);
    client.loadExecutionResponseMetadata.mockResolvedValue(undefined);
    client.loadExecutionResponseBody.mockResolvedValue(undefined);
    const harness = createHarness();

    await harness.workbench.initialize();

    expect(harness.errorMessage.value).toContain("handle is unavailable");
    expect(harness.workbench.response.value).toBeNull();
    harness.workbench.dispose();
  });

  it("restores the latest response and an active execution", async () => {
    const succeeded = summary({
      executionId: "execution-complete",
      requestId: "request-complete",
      state: "succeeded",
      revision: 2,
      responseHandle: "response-complete",
    });
    const running = summary({
      executionId: "execution-running",
      requestId: "request-running",
      state: "running",
      revision: 1,
      updatedAt: "2026-09-06T00:00:02.000Z",
    });
    client.listExecutionSummaries.mockResolvedValue([running, succeeded]);
    client.loadExecutionResponseMetadata.mockResolvedValue(
      response("request-complete", "execution-complete", "response-complete"),
    );
    const harness = createHarness();

    await harness.workbench.initialize();

    expect(harness.workbench.response.value?.requestId).toBe(
      "request-complete",
    );
    expect(harness.workbench.activeExecutionId.value).toBe("execution-running");
    expect(harness.busy.value).toBe(true);
    harness.workbench.dispose();
  });

  it("rejects a late lower-revision event after completion", async () => {
    const running = summary({
      executionId: "execution-1",
      requestId: "request-1",
      state: "running",
      revision: 1,
    });
    client.startBackgroundExecution.mockResolvedValue(running);
    client.loadExecutionResponseMetadata.mockResolvedValue(
      response("request-1", "execution-1", "response-1"),
    );
    const harness = createHarness();
    await harness.workbench.initialize();
    await harness.workbench.run({
      request: createDefaultRequest({
        id: "request-1",
        name: "Request",
        method: "GET",
        url: "https://example.com",
      }),
      target: { kind: "browser" },
    });
    listener?.({
      protocolVersion: 1,
      eventId: "completed",
      type: "execution.completed",
      execution: {
        ...running,
        state: "succeeded",
        revision: 3,
        responseHandle: "response-1",
        progress: progress("complete"),
      },
    });
    await flushPromises();
    listener?.({
      protocolVersion: 1,
      eventId: "late",
      type: "execution.progress",
      execution: { ...running, revision: 2 },
    });
    await flushPromises();

    expect(harness.busy.value).toBe(false);
    expect(harness.workbench.response.value?.handle).toBe("response-1");
    harness.workbench.dispose();
  });

  it("keeps the previous response when a newer execution fails", async () => {
    const previous = summary({
      executionId: "execution-old",
      requestId: "request-old",
      state: "succeeded",
      revision: 2,
      responseHandle: "response-old",
    });
    client.listExecutionSummaries.mockResolvedValue([previous]);
    client.loadExecutionResponseMetadata.mockResolvedValue(
      response("request-old", "execution-old", "response-old"),
    );
    const running = summary({
      executionId: "execution-new",
      requestId: "request-new",
      state: "running",
      revision: 1,
    });
    client.startBackgroundExecution.mockResolvedValue(running);
    const harness = createHarness();
    await harness.workbench.initialize();
    await harness.workbench.run({
      request: createDefaultRequest({
        id: "request-new",
        name: "New",
        method: "GET",
        url: "https://example.com/new",
      }),
      target: { kind: "browser" },
    });
    listener?.({
      protocolVersion: 1,
      eventId: "failed",
      type: "execution.failed",
      execution: {
        ...running,
        state: "failed",
        revision: 2,
        error: { code: "network", message: "Network unavailable" },
      },
    });
    await flushPromises();

    expect(harness.workbench.response.value?.handle).toBe("response-old");
    expect(harness.errorMessage.value).toBe("Network unavailable");
    expect(harness.workbench.executionProgress.value).toBeNull();
    harness.workbench.dispose();
  });

  it("cancels once and persists retention and limit preferences", async () => {
    const running = summary({
      executionId: "execution-active",
      requestId: "request-active",
      state: "running",
      revision: 1,
    });
    client.listExecutionSummaries.mockResolvedValue([running]);
    client.saveExecutionPreferences.mockResolvedValue({
      schemaVersion: 1,
      retention: "manual",
      responseLimitBytes: 5 * 1024 * 1024,
    });
    const harness = createHarness();
    await harness.workbench.initialize();

    await Promise.all([harness.workbench.stop(), harness.workbench.stop()]);
    await harness.workbench.savePreferences("manual", 5);
    await harness.workbench.clearResults();

    expect(client.cancelBackgroundExecution).toHaveBeenCalledOnce();
    expect(harness.workbench.cancelling.value).toBe(true);
    expect(harness.workbench.retention.value).toBe("manual");
    expect(harness.workbench.responseLimitMiB.value).toBe(5);
    expect(client.clearBackgroundExecutionResults).toHaveBeenCalledOnce();
    harness.workbench.dispose();
  });
});
