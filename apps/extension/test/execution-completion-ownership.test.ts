// @vitest-environment node
import "fake-indexeddb/auto";

import { createDefaultRequest, type ResponseRecordV1 } from "@xpanel/contracts";
import { deleteDB } from "idb";
import { beforeAll, describe, expect, it } from "vitest";

import { completeStreamedExecution } from "../src/lib/execution-completion";
import {
  completeExecution,
  loadExecutionPayload,
  stageExecution,
} from "../src/lib/execution-repository";

function response(requestId: string): ResponseRecordV1 {
  return {
    requestId,
    executor: "browser",
    status: 200,
    statusText: "OK",
    headers: [],
    body: {
      kind: "inline",
      encoding: "utf8",
      content: "{}",
      mediaType: "application/json",
      sizeBytes: 2,
    },
    timings: { startedAt: new Date().toISOString(), durationMs: 5 },
    redirects: [],
    warnings: [],
  };
}

async function stagePair(label: string) {
  const owned = await stageExecution(
    {
      request: createDefaultRequest({ id: `request-owned-${label}` }),
      target: { kind: "browser" },
    },
    "ownership-session",
  );
  const other = await stageExecution(
    {
      request: createDefaultRequest({ id: `request-other-${label}` }),
      target: { kind: "browser" },
    },
    "ownership-session",
  );
  return { owned, other };
}

describe("execution completion payload ownership", () => {
  beforeAll(async () => {
    await deleteDB("xpanel");
  });

  it("cleans only the completing execution payload for inline and streamed bodies", async () => {
    const inline = await stagePair("inline");
    await completeExecution(
      inline.owned.summary.executionId,
      inline.other.payloadHandle,
      response(inline.owned.summary.requestId),
    );
    await expect(
      loadExecutionPayload(inline.owned.payloadHandle),
    ).resolves.toBeUndefined();
    await expect(
      loadExecutionPayload(inline.other.payloadHandle),
    ).resolves.toBeDefined();

    const streamed = await stagePair("streamed");
    const streamedResponse = response(streamed.owned.summary.requestId);
    const metadata = {
      requestId: streamedResponse.requestId,
      executor: streamedResponse.executor,
      status: streamedResponse.status,
      statusText: streamedResponse.statusText,
      headers: streamedResponse.headers,
      timings: streamedResponse.timings,
      redirects: streamedResponse.redirects,
      warnings: streamedResponse.warnings,
    };
    await completeStreamedExecution({
      executionId: streamed.owned.summary.executionId,
      payloadHandle: streamed.other.payloadHandle,
      response: metadata,
      body: {
        kind: "stored",
        encoding: "utf8",
        mediaType: "application/json",
        sizeBytes: 2,
      },
      blob: new Blob(["{}"], { type: "application/json" }),
    });
    await expect(
      loadExecutionPayload(streamed.owned.payloadHandle),
    ).resolves.toBeUndefined();
    await expect(
      loadExecutionPayload(streamed.other.payloadHandle),
    ).resolves.toBeDefined();
  });

  it.each(["verified", "failed", "unverified", "pending"] as const)(
    "stores %s remote integrity without promoting uncertain bodies to success",
    async (integrity) => {
      const staged = await stageExecution(
        { request: createDefaultRequest(), target: { kind: "browser" } },
        "integrity-session",
      );
      const { body, ...metadata } = response(staged.summary.requestId);
      const result = await completeStreamedExecution({
        executionId: staged.summary.executionId,
        payloadHandle: staged.payloadHandle,
        response: {
          ...metadata,
          executor: "remote",
          remoteDetails: {
            schemaVersion: 1,
            source: "target",
            integrity,
            outerStatus: 200,
            outerHeaders: [],
            mutations: [],
            audit: "recorded",
            ...(integrity === "unverified"
              ? { reason: "report-unavailable" }
              : {}),
          },
        },
        body: {
          kind: "stored",
          encoding: body.encoding,
          sizeBytes: body.sizeBytes,
        },
        blob: new Blob(["{}"]),
      });
      expect(result.state).toBe(
        integrity === "verified" ? "succeeded" : "failed",
      );
      expect(result.responseHandle).toBeDefined();
      if (integrity === "unverified")
        expect(result.error?.code).toBe("report-unavailable");
      expect(await loadExecutionPayload(staged.payloadHandle)).toBeUndefined();
    },
  );
});
