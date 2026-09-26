// @vitest-environment node
import "fake-indexeddb/auto";

import { exportHar, importHar } from "@xpanel/request-core";
import { describe, expect, it } from "vitest";

import { storeDetachedExecutionResponse } from "../src/lib/execution-detached-response";
import {
  createStoredResponseRecords,
  loadExecutionResponse,
  loadExecutionResponseBody,
} from "../src/lib/execution-response-store";

describe("HAR response persistence", () => {
  it("persists and exports all 14 mixed captured/missing responses", async () => {
    const contents = [
      { size: 318_000 },
      { size: 100, text: "" },
      { size: -1 },
      {},
      { size: 1, text: "中文🙂" },
      { size: 100, text: "plain" },
      { size: 0, text: "captured" },
      { size: 999, text: "AP8BAg==", encoding: "base64" },
      { text: "AP8BAg==", encoding: "base64" },
      { text: "AP8B\nAg==", encoding: "base64" },
      { size: 40, text: "!invalid!", encoding: "base64" },
      { size: 40, text: "opaque", encoding: "unsupported" },
      { size: 0, text: "" },
      { size: 4, text: "last" },
    ];
    const result = importHar({
      log: {
        version: "1.2",
        entries: contents.map((content, index) => ({
          request: { method: "GET", url: `https://example.invalid/${index}` },
          response: { status: 200, content },
        })),
      },
    });
    const loaded = [];
    for (const response of result.responses) {
      const summary = await storeDetachedExecutionResponse(
        response,
        "10m",
        "har-test",
      );
      const blob = await loadExecutionResponseBody(summary.responseHandle!);
      const restored = await loadExecutionResponse(summary.responseHandle!);
      expect(blob?.size).toBe(response.body.sizeBytes);
      expect(restored?.body.sizeBytes).toBe(summary.progress.loadedBytes);
      expect(restored?.warnings).toEqual(response.warnings);
      expect(restored?.headers).toEqual(response.headers);
      expect(restored).toBeDefined();
      loaded.push(restored!);
    }
    expect(loaded).toHaveLength(14);
    expect(loaded[4]?.body.content).toBe("中文🙂");
    expect(loaded[7]?.body.content).toBe("AP8BAg==");
    const exported = importHar(
      exportHar(result.requests, loaded, { includeSensitive: true }),
    );
    expect(exported.responses.map((item) => item.body.sizeBytes)).toEqual(
      loaded.map((item) => item.body.sizeBytes),
    );
  });

  it("still rejects mismatched sizes at the storage boundary", () => {
    const response = importHar({
      log: {
        version: "1.2",
        entries: [
          {
            request: { method: "GET", url: "https://example.invalid/" },
            response: { status: 200, content: { text: "ok", size: 2 } },
          },
        ],
      },
    }).responses[0]!;
    response.body.sizeBytes = 100;
    expect(() =>
      createStoredResponseRecords({
        executionId: "invalid-test",
        responseHandle: "invalid-body",
        response,
        createdAt: new Date().toISOString(),
      }),
    ).toThrow("Stored response size does not match its body metadata.");
  });
});
