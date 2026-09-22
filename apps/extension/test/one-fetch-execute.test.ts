import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeRequestMetadata } from "@one-fetch/protocol";
import { createDefaultRequest } from "@xpanel/contracts";
import { cancelRequest, executeRemote } from "../src/lib/execute";
import { openRemoteResponse } from "../src/lib/execution/remote";
import { bindFile } from "../src/lib/file-bindings";
import {
  capabilities,
  fetchInputUrl,
  consent,
  profile,
  signedResponse,
  token,
} from "./one-fetch.fixture";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal("chrome", {
    // Offscreen exposes only a subset of runtime; getManifest is unavailable.
    runtime: {},
    permissions: {
      request: vi.fn(async () => true),
      contains: vi.fn(async () => true),
    },
  });
});
const remoteTarget = () => ({
  kind: "remote" as const,
  profile: profile(),
  consent,
  token,
});
function mockTransport(
  handler: (input: RequestInfo | URL, init: RequestInit) => Promise<Response>,
) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (fetchInputUrl(input).endsWith("/api/v1/capabilities"))
      return Response.json(capabilities());
    if (fetchInputUrl(input).includes("/api/v1/reports/"))
      return new Response("not ready", { status: 404 });
    return handler(input, init ?? {});
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("one-fetch HTTP execution", () => {
  it("preserves arbitrary path/query, method, body and duplicate target headers", async () => {
    const request = createDefaultRequest();
    request.method = "POST";
    request.url = "https://target.example/v1//a%2Fb?x=%20&x=2";
    request.query = [{ name: "x", value: "third value", enabled: true }];
    request.body = { kind: "json", text: "{}" };
    request.headers = [
      "Cookie",
      "Authorization",
      "DNT",
      "Origin",
      "Referer",
      "Sec-Fetch-Site",
      "X-Repeat",
      "X-Repeat",
    ].map((name) => ({ name, value: "synthetic", enabled: true }));
    const fetch = mockTransport(async (url, init) => {
      expect(fetchInputUrl(url)).toBe(
        "https://gateway.example/gateway/v1//a%2Fb?x=%20&x=2&x=third%20value",
      );
      expect(init.method).toBe("POST");
      expect(await new Response(init.body).text()).toBe("{}");
      expect(init.credentials).toBe("omit");
      expect(init.redirect).toBe("manual");
      const meta = decodeRequestMetadata(
        new Headers(init.headers).get("One-Fetch-Request")!,
      );
      expect(
        meta.targetHeaders.filter((h) => h.name === "X-Repeat"),
      ).toHaveLength(2);
      expect(meta.targetOrigin).toBe("https://target.example");
      expect(meta.fetchOptions.adapter?.browserResponse).toBe("envelope-v1");
      return signedResponse(init);
    });
    expect((await executeRemote(request, remoteTarget())).body.content).toBe(
      "ok",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(chrome.permissions.request).toHaveBeenCalledWith({
      origins: ["https://control.example/*", "https://gateway.example/*"],
    });
  });
  it.each([200, 301, 400, 401, 404, 500, 503])(
    "classifies signed target HTTP %i as a target, not a relay error",
    async (status) => {
      const request = {
        ...createDefaultRequest(),
        url: "https://target.example/",
      };
      mockTransport(async (_url, init) =>
        signedResponse(init, "result", {
          target: {
            kind: "http",
            status,
            statusText: "Synthetic",
            headers: [],
            setCookie: [],
            bodyComplete: true,
          },
        }),
      );
      const response = await openRemoteResponse(request, remoteTarget());
      expect(response.status).toBe(status);
      expect(response.remoteDetails).toMatchObject({
        source: "target",
        outerStatus: 200,
      });
      await new Response(response.stream).text();
      await response.finalizeRemote!();
    },
  );
  it("preserves separate Set-Cookie values and target Server-Timing without applying cookies", async () => {
    const request = {
      ...createDefaultRequest(),
      url: "https://target.example/",
    };
    mockTransport(async (_url, init) =>
      signedResponse(init, "ok", {
        target: {
          kind: "http",
          status: 200,
          statusText: "OK",
          headers: [{ name: "Server-Timing", value: "db;dur=3" }],
          setCookie: ["a=1; HttpOnly", "b=2; Secure"],
          bodyComplete: true,
        },
        timing: {
          phases: [{ name: "dns", state: "unavailable", source: "gateway" }],
          serverTiming: [{ name: "db", durationMs: 3 }],
        },
      }),
    );
    const response = await openRemoteResponse(request, remoteTarget());
    expect(
      response.headers.filter((h) => h.name === "Set-Cookie"),
    ).toHaveLength(2);
    expect(
      response.remoteDetails?.timing?.phases[0]?.durationMs,
    ).toBeUndefined();
    await new Response(response.stream).arrayBuffer();
    expect((await response.finalizeRemote!()).integrity).toBe("unverified");
  });
  it.each(["unsigned", "bad-signature", "wrong-request"])(
    "labels %s responses as intermediary diagnostics even with HTTP 200",
    async (mode) => {
      mockTransport(async (_url, init) =>
        mode === "unsigned"
          ? new Response("<script>not executed</script>")
          : signedResponse(
              init,
              "diagnostic",
              mode === "wrong-request"
                ? { requestId: crypto.randomUUID() }
                : {},
              mode === "bad-signature" ? "wrong-token" : token,
            ),
      );
      const response = await openRemoteResponse(
        { ...createDefaultRequest(), url: "https://target.example" },
        remoteTarget(),
      );
      expect(response.remoteDetails?.source).toBe("intermediary");
      await new Response(response.stream).text();
      await response.finalizeRemote!();
    },
  );
  it("separates a signed policy error from the target", async () => {
    mockTransport(async (_url, init) =>
      signedResponse(init, "denied", {
        outcome: "relay-error",
        target: undefined,
        error: {
          code: "target_not_allowed",
          origin: "one-fetch",
          stage: "policy",
          message: "Denied",
          retryable: false,
        },
      }),
    );
    const response = await openRemoteResponse(
      { ...createDefaultRequest(), url: "https://target.example" },
      remoteTarget(),
    );
    expect(response.remoteDetails?.source).toBe("relay-error");
    expect(response.remoteDetails?.problem?.stage).toBe("policy");
    await new Response(response.stream).text();
    await response.finalizeRemote!();
  });
  it("keeps browser-hidden redirects as unavailable, unverified diagnostics", async () => {
    mockTransport(async () => {
      const response = Response.error();
      Object.defineProperty(response, "type", { value: "opaqueredirect" });
      return response;
    });
    const response = await openRemoteResponse(
      { ...createDefaultRequest(), url: "https://target.example" },
      remoteTarget(),
    );
    expect(response.status).toBe(0);
    expect(response.remoteDetails).toMatchObject({
      source: "intermediary",
      outerStatus: 0,
      reason: "browser-opaque-redirect",
      integrity: "unverified",
    });
    await new Response(response.stream).text();
    expect((await response.finalizeRemote!()).integrity).toBe("unverified");
  });
  it("blocks config changes between consent and send without making a target request", async () => {
    const fetch = mockTransport(async (_url, init) => signedResponse(init));
    await expect(
      executeRemote(
        { ...createDefaultRequest(), url: "https://target.example" },
        { ...remoteTarget(), consent: { ...consent, configVersion: "old" } },
      ),
    ).rejects.toThrow("configuration changed");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    "Host",
    "Content-Length",
    "Upgrade",
    "Proxy-Authorization",
    "Set-Cookie",
  ])("blocks %s before any fetch", async (name) => {
    const fetch = mockTransport(async (_url, init) => signedResponse(init));
    await expect(
      executeRemote(
        {
          ...createDefaultRequest(),
          url: "https://target.example",
          headers: [{ name, value: "x", enabled: true }],
        },
        remoteTarget(),
      ),
    ).rejects.toThrow("cannot preserve");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps selected files as Blob bodies and refuses imported paths", async () => {
    const file = new File(["upload"], "synthetic.txt", { type: "text/plain" });
    const reference = {
      id: crypto.randomUUID(),
      name: file.name,
      size: file.size,
      requiresReselection: true,
    };
    const request = {
      ...createDefaultRequest(),
      method: "POST",
      url: "https://target.example",
      body: { kind: "file" as const, file: reference },
    };
    const fetch = mockTransport(async (_url, init) => {
      expect(init.body).toBe(file);
      return signedResponse(init);
    });
    await expect(executeRemote(request, remoteTarget())).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    bindFile(reference, file);
    reference.requiresReselection = false;
    await executeRemote(request, remoteTarget());
  });
  it("limits unsigned diagnostics to 1 MiB", async () => {
    mockTransport(async () => new Response("x".repeat(1024 * 1024 + 1)));
    const response = await openRemoteResponse(
      { ...createDefaultRequest(), url: "https://target.example" },
      remoteTarget(),
    );
    expect((await new Response(response.stream).arrayBuffer()).byteLength).toBe(
      1024 * 1024,
    );
    await response.finalizeRemote!();
  });
  it("cancels the Gateway request and does not accept a late success", async () => {
    const request = {
      ...createDefaultRequest(),
      url: "https://target.example",
    };
    const fetch = mockTransport(
      async (_url, init) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          ),
        ),
    );
    const result = executeRemote(request, remoteTarget());
    const rejected = expect(result).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(cancelRequest(request.id)).toBe(true);
    await rejected;
  });
});
