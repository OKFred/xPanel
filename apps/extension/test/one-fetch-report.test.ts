import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionReportV1 } from "@one-fetch/protocol";
import type { OneFetchResponseDetailsV1 } from "@xpanel/contracts";
import {
  finalizeRemoteReport,
  safeOuterHeaders,
  diagnosticResponse,
} from "../src/lib/execution/one-fetch-report";
import { profile, token, fetchInputUrl } from "./one-fetch.fixture";

const details: OneFetchResponseDetailsV1 = {
  schemaVersion: 1,
  source: "target",
  outerStatus: 503,
  outerHeaders: [],
  mutations: [],
  audit: "recorded",
  integrity: "pending",
  reportId: "report-synthetic",
};
const report: ExecutionReportV1 = {
  schemaVersion: 1,
  reportId: "report-synthetic",
  requestId: "request-synthetic",
  source: "target",
  outcome: "completed",
  status: 503,
  responseBytes: 2,
  bodyComplete: true,
  bodySha256: "a".repeat(64),
  timing: { phases: [], serverTiming: [] },
  finishedAt: "2026-09-22T00:00:00Z",
  auditState: "recorded",
};
const finalize = (signal = new AbortController().signal) =>
  finalizeRemoteReport(
    details,
    profile(),
    token,
    "request-synthetic",
    2,
    signal,
    503,
  );
beforeEach(() => vi.restoreAllMocks());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("one-fetch final report verification", () => {
  it("binds a browser envelope to signed target status, not outer HTTP 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(report)),
    );
    const result = await finalizeRemoteReport(
      { ...details, outerStatus: 200 },
      profile(),
      token,
      "request-synthetic",
      2,
      new AbortController().signal,
      503,
    );
    expect(result.integrity).toBe("pending");
    expect(result.bodySha256).toBe(report.bodySha256);
  });
  it.each([204, 205, 304])(
    "preserves unsigned bodyless status %i",
    (status) => {
      const response = new Response(null, { status });
      expect(diagnosticResponse(response)).toBe(response);
    },
  );
  it("bounds intermediary diagnostics and cancels excess bytes", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("synthetic diagnostic"));
      },
      cancel,
    });
    const response = diagnosticResponse(new Response(body, { status: 502 }), 9);
    expect(await response.text()).toBe("synthetic");
    expect(response.status).toBe(502);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("fetches the report with the execution token and leaves SHA-256 verification to the body worker", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        expect(fetchInputUrl(url)).toContain(
          "/api/v1/reports/report-synthetic",
        );
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          `Bearer ${token}`,
        );
        expect(init?.redirect).toBe("error");
        expect(init?.credentials).toBe("omit");
        return Response.json(report);
      }),
    );
    expect(await finalize()).toMatchObject({
      integrity: "pending",
      bodySha256: report.bodySha256,
    });
  });
  it.each([
    "partial",
    "timeout",
    "cancelled",
    "relay-error",
    "orphaned",
  ] as const)(
    "rejects %s even when the target status was successful",
    async (outcome) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ ...report, outcome })),
      );
      expect(await finalize()).toMatchObject({
        integrity: "failed",
        reason: `report-${outcome}`,
      });
    },
  );
  it.each([{ requestId: "another" }, { reportId: "another" }, { status: 200 }])(
    "rejects mismatched report identity %j",
    async (change) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ ...report, ...change })),
      );
      expect(await finalize()).toMatchObject({
        integrity: "failed",
        reason: "report-identity-mismatch",
      });
    },
  );
  it.each([
    { bodyComplete: false },
    { responseBytes: 3 },
    { source: "vendor" },
  ])("does not promote incomplete or non-target reports %j", async (change) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ...report, ...change })),
    );
    expect((await finalize()).integrity).toBe("failed");
  });
  it("bounds retries and explicitly marks unavailable reports unverified", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      async () => new Response("unavailable", { status: 404 }),
    );
    vi.stubGlobal("fetch", fetch);
    const pending = finalize();
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({
      integrity: "unverified",
      reason: "report-unavailable",
    });
    expect(fetch).toHaveBeenCalledTimes(6);
  });
  it("waits for a delayed partial report instead of promoting an early 404", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () =>
      Response.json({
        ...report,
        outcome: "partial",
        bodyComplete: false,
      }),
    );
    for (let attempt = 0; attempt < 4; attempt += 1)
      fetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    const pending = finalize();
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({
      integrity: "failed",
      reason: "report-partial",
    });
    expect(fetch).toHaveBeenCalledTimes(5);
  });
  it("stops immediately during report backoff without issuing another fetch", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetch = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    const pending = finalize(controller.signal);
    const rejected = expect(pending).rejects.toThrow("Request cancelled");
    await vi.advanceTimersByTimeAsync(10);
    controller.abort(new DOMException("Request cancelled", "AbortError"));
    await rejected;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not retry a rejected execution credential", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    expect((await finalize()).integrity).toBe("unverified");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not invent integrity verification when the report has no digest", async () => {
    const withoutDigest = { ...report };
    delete withoutDigest.bodySha256;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(withoutDigest)),
    );
    expect(await finalize()).toMatchObject({
      integrity: "unverified",
      reason: "report-digest-unavailable",
    });
  });
  it("aborts report retrieval and filters protocol metadata and secrets from outer headers", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(finalize(controller.signal)).rejects.toThrow();
    expect(
      safeOuterHeaders(
        new Headers({
          "One-Fetch-Response": "signed-cookie-secret",
          "Set-Cookie": "secret",
          "X-One-Fetch-Token": token,
          Authorization: token,
          Server: "synthetic",
        }),
      ),
    ).toEqual([{ name: "Server", value: "synthetic" }]);
  });
});
