import { describe, expect, test, vi } from "vitest";

import { REMOTE_MAX_RESPONSE_BODY_BYTES } from "@xpanel/contracts";

import type { Fetcher } from "../src/executor";
import {
  createEnv,
  createMetadata,
  executeRelay,
  readRelayError,
  readResponseMetadata,
} from "./helpers";

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

describe("redirect policy", () => {
  test("manual returns the first 3xx without following it", async () => {
    const fetcher = vi.fn<Fetcher>(() =>
      Promise.resolve(
        new Response("move", {
          status: 302,
          headers: { Location: "/next" },
        }),
      ),
    );
    const response = await executeRelay(
      fetcher,
      createMetadata({ redirect: "manual" }),
    );
    const metadata = readResponseMetadata(response);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(metadata.status).toBe(302);
    expect(metadata.redirects).toEqual([]);
    expect(metadata.headers).toContainEqual({
      name: "location",
      value: "/next",
    });
  });

  test("error rejects the first redirect with a stable error code", async () => {
    const response = await executeRelay(
      () =>
        Promise.resolve(
          new Response(null, {
            status: 307,
            headers: { Location: "/next" },
          }),
        ),
      createMetadata({ redirect: "error" }),
    );

    expect(response.status).toBe(400);
    await expect(readRelayError(response)).resolves.toMatchObject({
      requestId: "request-1",
      error: { code: "redirect_disallowed" },
    });
  });

  test("follow preserves method, body, and headers for a same-origin 307", async () => {
    const body = new TextEncoder().encode("same-origin payload");
    const calls: Array<{
      url: string;
      method: string | undefined;
      headers: Headers;
      body: string;
    }> = [];
    const fetcher: Fetcher = async (input, init) => {
      calls.push({
        url: requestUrl(input),
        method: init?.method,
        headers: new Headers(init?.headers),
        body:
          init?.body === undefined ? "" : await new Response(init.body).text(),
      });
      return calls.length === 1
        ? new Response(null, {
            status: 307,
            headers: { Location: "/next" },
          })
        : new Response("done");
    };
    const response = await executeRelay(
      fetcher,
      createMetadata({
        method: "POST",
        headers: [{ name: "Authorization", value: "Bearer target" }],
        bodySizeBytes: body.byteLength,
      }),
      body,
    );
    const metadata = readResponseMetadata(response);

    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      url: "https://api.example.com/next",
      method: "POST",
      body: "same-origin payload",
    });
    expect(calls[1]?.headers.get("authorization")).toBe("Bearer target");
    expect(metadata.redirects).toHaveLength(1);
    expect(metadata.redirects[0]).toMatchObject({
      url: "https://api.example.com/next",
      status: 307,
      method: "POST",
    });
  });

  test("follow strips every request header on a cross-origin 303 and changes POST to GET", async () => {
    const body = new TextEncoder().encode("drop me");
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetcher: Fetcher = (input, init) => {
      calls.push({ url: requestUrl(input), init });
      return Promise.resolve(
        calls.length === 1
          ? new Response(null, {
              status: 303,
              headers: { Location: "https://other.example.org/final" },
            })
          : new Response("done"),
      );
    };
    const response = await executeRelay(
      fetcher,
      createMetadata({
        method: "POST",
        headers: [
          { name: "Authorization", value: "Bearer target" },
          { name: "Cookie", value: "session=secret" },
          { name: "X-Custom", value: "also stripped" },
          { name: "Content-Type", value: "text/plain" },
        ],
        bodySizeBytes: body.byteLength,
      }),
      body,
      createEnv({
        ALLOWED_TARGET_ORIGINS:
          "https://api.example.com https://other.example.org",
      }),
    );
    const metadata = readResponseMetadata(response);
    const secondHeaders = new Headers(calls[1]?.init?.headers);

    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe("https://other.example.org/final");
    expect(calls[1]?.init?.method).toBe("GET");
    expect(calls[1]?.init?.body).toBeUndefined();
    expect([...secondHeaders]).toEqual([]);
    expect(metadata.warnings).toEqual([
      expect.objectContaining({
        code: "remote.redirect_headers_stripped",
        path: "headers",
      }),
    ]);
  });

  test("drops every Fetch request-body header when a same-origin redirect changes POST to GET", async () => {
    const body = new TextEncoder().encode("drop me");
    const calls: RequestInit[] = [];
    const fetcher: Fetcher = (_input, init) => {
      calls.push(init ?? {});
      return Promise.resolve(
        calls.length === 1
          ? new Response(null, {
              status: 303,
              headers: { Location: "/final" },
            })
          : new Response("done"),
      );
    };

    await executeRelay(
      fetcher,
      createMetadata({
        method: "POST",
        headers: [
          { name: "Content-Encoding", value: "identity" },
          { name: "Content-Language", value: "en" },
          { name: "Content-Location", value: "/source" },
          { name: "Content-Type", value: "text/plain" },
          { name: "X-Keep", value: "yes" },
        ],
        bodySizeBytes: body.byteLength,
      }),
      body,
    );

    const redirectedHeaders = new Headers(calls[1]?.headers);
    expect(calls[1]?.method).toBe("GET");
    expect(calls[1]?.body).toBeUndefined();
    expect([...redirectedHeaders]).toEqual([["x-keep", "yes"]]);
  });

  test("does not replay a body across origins without user confirmation", async () => {
    const body = new TextEncoder().encode("sensitive payload");
    const fetcher = vi.fn<Fetcher>(() =>
      Promise.resolve(
        new Response(null, {
          status: 307,
          headers: { Location: "https://other.example.org/final" },
        }),
      ),
    );
    const response = await executeRelay(
      fetcher,
      createMetadata({
        method: "POST",
        headers: [{ name: "Authorization", value: "Bearer target" }],
        bodySizeBytes: body.byteLength,
      }),
      body,
      createEnv({
        ALLOWED_TARGET_ORIGINS:
          "https://api.example.com https://other.example.org",
      }),
    );
    const metadata = readResponseMetadata(response);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(metadata.status).toBe(307);
    expect(metadata.redirects).toEqual([]);
    expect(metadata.warnings).toEqual([
      expect.objectContaining({
        code: "remote.redirect_body_replay_requires_confirmation",
        path: "options.redirect",
      }),
    ]);
  });

  test.each([
    {
      name: "a follow redirect without Location",
      location: undefined,
      crossOriginBody: false,
    },
    {
      name: "a cross-origin redirect whose body cannot be replayed",
      location: "https://other.example.org/final",
      crossOriginBody: true,
    },
  ])("rejects an oversized declared response for $name", async (scenario) => {
    const body = scenario.crossOriginBody
      ? new TextEncoder().encode("sensitive payload")
      : new Uint8Array();
    const response = await executeRelay(
      () =>
        Promise.resolve(
          new Response(Uint8Array.of(1), {
            status: 307,
            headers: {
              "Content-Length": String(REMOTE_MAX_RESPONSE_BODY_BYTES + 1),
              ...(scenario.location === undefined
                ? {}
                : { Location: scenario.location }),
            },
          }),
        ),
      createMetadata({
        method: scenario.crossOriginBody ? "POST" : "GET",
        bodySizeBytes: body.byteLength,
      }),
      body,
      createEnv({
        ALLOWED_TARGET_ORIGINS:
          "https://api.example.com https://other.example.org",
      }),
    );

    expect(response.status).toBe(502);
    await expect(readRelayError(response)).resolves.toMatchObject({
      error: { code: "response_too_large" },
    });
  });

  test("revalidates every redirect target against SSRF policy", async () => {
    let responseBodyCancelled = false;
    const fetcher = vi.fn<Fetcher>(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              responseBodyCancelled = true;
              throw new Error("synthetic cancellation failure");
            },
          }),
          {
            status: 302,
            headers: { Location: "https://127.0.0.1/private" },
          },
        ),
      ),
    );
    const response = await executeRelay(
      fetcher,
      createMetadata({ redirect: "follow" }),
      new Uint8Array(),
      createEnv({ TARGET_POLICY: "public-https" }),
    );

    expect(fetcher).toHaveBeenCalledOnce();
    expect(responseBodyCancelled).toBe(true);
    expect(response.status).toBe(403);
    await expect(readRelayError(response)).resolves.toMatchObject({
      error: { code: "target_not_allowed" },
    });
  });

  test("stops after 20 redirects", async () => {
    let hop = 0;
    const fetcher: Fetcher = () => {
      hop += 1;
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { Location: `/hop-${hop}` },
        }),
      );
    };
    const response = await executeRelay(fetcher);

    expect(hop).toBe(21);
    expect(response.status).toBe(400);
    await expect(readRelayError(response)).resolves.toMatchObject({
      error: { code: "redirect_disallowed" },
    });
  });
});

describe("timeout and cancellation", () => {
  function waitForAbortFetcher(
    onSignal?: (signal: AbortSignal) => void,
  ): Fetcher {
    return (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === null || signal === undefined) {
          reject(new Error("Expected an abort signal."));
          return;
        }
        onSignal?.(signal);
        const rejectAbort = (): void =>
          reject(new DOMException("Aborted", "AbortError"));
        if (signal.aborted) rejectAbort();
        else signal.addEventListener("abort", rejectAbort, { once: true });
      });
  }

  test("maps the configured request timeout to a timeout envelope", async () => {
    const response = await executeRelay(
      waitForAbortFetcher(),
      createMetadata({ timeoutMs: 10 }),
    );

    expect(response.status).toBe(504);
    await expect(readRelayError(response)).resolves.toMatchObject({
      requestId: "request-1",
      error: { code: "timeout" },
    });
  });

  test("propagates caller cancellation to the active upstream fetch", async () => {
    const controller = new AbortController();
    let upstreamSignal: AbortSignal | undefined;
    const responsePromise = executeRelay(
      waitForAbortFetcher((signal) => {
        upstreamSignal = signal;
      }),
      createMetadata(),
      new Uint8Array(),
      createEnv(),
      { signal: controller.signal },
    );

    await vi.waitFor(() => expect(upstreamSignal).toBeDefined());
    controller.abort("user stopped");
    const response = await responsePromise;

    expect(upstreamSignal?.aborted).toBe(true);
    expect(response.status).toBe(499);
    await expect(readRelayError(response)).resolves.toMatchObject({
      requestId: "request-1",
      error: { code: "cancelled" },
    });
  });
});
