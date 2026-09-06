// @vitest-environment node
import "fake-indexeddb/auto";

import { createDefaultRequest } from "@xpanel/contracts";
import { deleteDB } from "idb";
import { beforeAll, describe, expect, it } from "vitest";

import {
  clearExecutionResults,
  completeExecution,
  countActiveExecutions,
  failExecution,
  listExecutionSummaries,
  loadExecutionFiles,
  loadExecutionPayload,
  markExecutionRunning,
  stageExecution,
  updateExecutionProgress,
} from "../src/lib/execution-repository";
import {
  QUEUED_DISPATCH_TIMEOUT_MS,
  cleanupPreviousSessions,
  markPreviousSessionExecutionsOrphaned,
  markStaleQueuedExecutionsOrphaned,
} from "../src/lib/execution-recovery";
import {
  loadExecutionResponse,
  loadExecutionResponseBody,
  loadExecutionResponseMetadata,
} from "../src/lib/execution-response-store";
import { storeDetachedExecutionResponse } from "../src/lib/execution-detached-response";
import {
  MAX_RESPONSE_LIMIT_BYTES,
  MIN_RESPONSE_LIMIT_BYTES,
} from "../src/lib/execution-storage";

let stagedExecutionId = "";
let stagedPayloadHandle = "";

describe("background execution repository", () => {
  beforeAll(async () => {
    await deleteDB("xpanel");
  });

  it("stores transient request bodies and files without runtime messages", async () => {
    const request = createDefaultRequest({
      id: "request-staged",
      method: "POST",
      url: "https://example.com/items",
      body: { kind: "json", text: '{"hello":"world"}' },
    });
    const file = new File(["fixture"], "fixture.txt", {
      type: "text/plain",
      lastModified: 1,
    });
    const staged = await stageExecution(
      { request, target: { kind: "browser" } },
      "session-1",
      [{ referenceId: "fixture-1", file }],
    );
    stagedExecutionId = staged.summary.executionId;
    stagedPayloadHandle = staged.payloadHandle;

    expect(staged.summary).toMatchObject({
      requestId: request.id,
      state: "queued",
      retention: "10m",
    });
    expect(await countActiveExecutions()).toBe(1);
    expect(await loadExecutionPayload(staged.payloadHandle)).toMatchObject({
      request: { body: request.body },
      responseLimitBytes: 20 * 1024 * 1024,
    });
    const files = await loadExecutionFiles(staged.payloadHandle);
    expect(files).toHaveLength(1);
    expect(await files[0]!.blob.text()).toBe("fixture");

    const running = await markExecutionRunning(staged.summary.executionId);
    const progressed = await updateExecutionProgress(
      staged.summary.executionId,
      {
        phase: "downloading",
        loadedBytes: 4,
        totalBytes: 8,
        elapsedMs: 25,
      },
    );
    expect(running.revision).toBe(1);
    expect(progressed.revision).toBe(2);
  });

  it("stores the response body behind a handle and clears transient input", async () => {
    const response = {
      requestId: "request-staged",
      executor: "browser" as const,
      status: 200,
      statusText: "OK",
      headers: [],
      body: {
        kind: "inline" as const,
        encoding: "utf8" as const,
        content: '{"ok":true}',
        mediaType: "application/json",
        sizeBytes: 11,
      },
      timings: {
        startedAt: new Date().toISOString(),
        durationMs: 30,
      },
      redirects: [],
      warnings: [],
    };
    const completed = await completeExecution(
      stagedExecutionId,
      stagedPayloadHandle,
      response,
    );

    expect(completed.state).toBe("succeeded");
    expect(completed.responseHandle).toBeTruthy();
    expect(
      Date.parse(completed.expiresAt!) - Date.parse(completed.updatedAt),
    ).toBe(10 * 60_000);
    expect(await loadExecutionPayload(stagedPayloadHandle)).toBeUndefined();
    const metadata = await loadExecutionResponseMetadata(
      completed.responseHandle!,
    );
    expect(metadata?.body).toMatchObject({
      kind: "stored",
      sizeBytes: 11,
    });
    expect(metadata).not.toHaveProperty("body.content");
    expect(
      await (
        await loadExecutionResponseBody(completed.responseHandle!)
      )?.text(),
    ).toBe('{"ok":true}');
    expect(
      (await loadExecutionResponse(completed.responseHandle!))?.body.content,
    ).toBe('{"ok":true}');
    expect(await countActiveExecutions()).toBe(0);
  });

  it("validates response limits and cleans previous-session results", async () => {
    const request = createDefaultRequest({ id: "request-session" });
    await expect(
      stageExecution(
        {
          request,
          target: { kind: "browser" },
          responseLimitBytes: MIN_RESPONSE_LIMIT_BYTES - 1,
        },
        "old-session",
      ),
    ).rejects.toThrow();
    await expect(
      stageExecution(
        {
          request,
          target: { kind: "browser" },
          responseLimitBytes: MAX_RESPONSE_LIMIT_BYTES + 1,
        },
        "old-session",
      ),
    ).rejects.toThrow();

    const session = await stageExecution(
      { request, target: { kind: "browser" }, retention: "session" },
      "old-session",
    );
    await failExecution(
      session.summary.executionId,
      session.payloadHandle,
      "cancelled",
      { code: "cancelled", message: "Request cancelled." },
    );
    expect(await cleanupPreviousSessions("new-session")).toHaveLength(1);
    expect(
      (await listExecutionSummaries()).some(
        (summary) => summary.executionId === session.summary.executionId,
      ),
    ).toBe(false);

    const manual = await stageExecution(
      {
        request: createDefaultRequest({ id: "request-manual" }),
        target: { kind: "browser" },
        retention: "manual",
      },
      "new-session",
    );
    await failExecution(
      manual.summary.executionId,
      manual.payloadHandle,
      "failed",
      { code: "fixture", message: "Fixture failure." },
    );
    await clearExecutionResults({
      expiredOnly: true,
      now: Date.now() + 86_400_000,
    });
    expect(
      (await listExecutionSummaries()).some(
        (summary) => summary.executionId === manual.summary.executionId,
      ),
    ).toBe(true);

    const interrupted = await stageExecution(
      {
        request: createDefaultRequest({ id: "request-interrupted" }),
        target: { kind: "browser" },
      },
      "old-session",
    );
    const current = await stageExecution(
      {
        request: createDefaultRequest({ id: "request-current" }),
        target: { kind: "browser" },
      },
      "new-session",
    );
    const orphaned = await markPreviousSessionExecutionsOrphaned("new-session");
    expect(orphaned).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          executionId: interrupted.summary.executionId,
          state: "orphaned",
        }),
      ]),
    );
    expect(
      orphaned.some(
        (summary) => summary.executionId === current.summary.executionId,
      ),
    ).toBe(false);
    expect(
      await loadExecutionPayload(interrupted.payloadHandle),
    ).toBeUndefined();
    expect(await loadExecutionPayload(current.payloadHandle)).toBeDefined();
  });

  it("stores an imported response as a terminal body handle", async () => {
    const summary = await storeDetachedExecutionResponse(
      {
        requestId: "imported-request",
        executor: "browser",
        status: 201,
        statusText: "Created",
        headers: [],
        body: {
          kind: "inline",
          encoding: "utf8",
          content: "imported",
          mediaType: "text/plain",
          sizeBytes: 8,
        },
        timings: {
          startedAt: new Date().toISOString(),
          durationMs: 4,
        },
        redirects: [],
        warnings: [],
      },
      "manual",
      "new-session",
    );

    expect(summary).toMatchObject({
      requestId: "imported-request",
      state: "succeeded",
      retention: "manual",
    });
    expect(
      await loadExecutionResponseBody(summary.responseHandle!),
    ).toBeInstanceOf(Blob);
    expect(
      (await loadExecutionResponseMetadata(summary.responseHandle!))?.body,
    ).not.toHaveProperty("content");
  });

  it("orphans a queued payload after its dispatch lease expires", async () => {
    const staged = await stageExecution(
      {
        request: createDefaultRequest({ id: "request-stale-queued" }),
        target: { kind: "browser" },
      },
      "current-session",
    );
    const now =
      Date.parse(staged.summary.createdAt) + QUEUED_DISPATCH_TIMEOUT_MS + 1;

    await expect(markStaleQueuedExecutionsOrphaned(now)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          executionId: staged.summary.executionId,
          state: "orphaned",
        }),
      ]),
    );
    await expect(
      loadExecutionPayload(staged.payloadHandle),
    ).resolves.toBeUndefined();
  });
});
