import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDefaultRequest } from "@xpanel/contracts";

import {
  cancelRequest,
  executeBrowser,
  executeNative,
  executeRequest,
  prepareNativePayload,
  requiresNative,
} from "../src/lib/execute";

function chromeMock(overrides: Partial<typeof chrome> = {}): typeof chrome {
  return {
    permissions: {
      contains: vi.fn(async () => true),
      request: vi.fn(async () => true),
    },
    runtime: {
      connectNative: vi.fn(),
    },
    ...overrides,
  } as unknown as typeof chrome;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal("chrome", chromeMock());
});

describe("executor selection", () => {
  it("keeps ordinary requests in the browser", () => {
    expect(
      requiresNative(createDefaultRequest({ url: "https://example.com" })),
    ).toBe(false);
  });

  it("routes forbidden browser headers to native replay", () => {
    const request = createDefaultRequest({
      headers: [{ name: "Cookie", value: "session=secret", enabled: true }],
    });
    expect(requiresNative(request)).toBe(true);
  });

  it("routes every Proxy- and Sec- header prefix to native replay", () => {
    for (const name of ["Proxy-Connection", "Sec-Example", "Cookie2"]) {
      const request = createDefaultRequest({
        headers: [{ name, value: "value", enabled: true }],
      });
      expect(requiresNative(request)).toBe(true);
    }
  });

  it("routes proxy and custom TLS requests to native replay", () => {
    const request = createDefaultRequest();
    request.options.proxy = { url: "http://127.0.0.1:8080", bypass: [] };
    expect(requiresNative(request)).toBe(true);
    request.options.proxy = null;
    request.options.tls.verify = false;
    expect(requiresNative(request)).toBe(true);
  });

  it("routes multipart part headers to native replay", () => {
    const request = createDefaultRequest({
      body: {
        kind: "multipart",
        parts: [
          {
            kind: "text",
            name: "metadata",
            value: "value",
            enabled: true,
            headers: [
              {
                name: "Content-Type",
                value: "application/json",
                enabled: true,
              },
            ],
          },
        ],
      },
    });
    expect(requiresNative(request)).toBe(true);
  });

  it("refuses to silently drop native-only fields in explicit Browser mode", async () => {
    const request = createDefaultRequest({
      url: "https://example.com",
      headers: [{ name: "Cookie", value: "session=secret", enabled: true }],
    });
    await expect(executeRequest(request, "browser")).rejects.toThrow(
      "cannot preserve",
    );
  });

  it("reports a denied origin permission before fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "chrome",
      chromeMock({
        permissions: {
          contains: vi.fn(async () => false),
          request: vi.fn(async () => false),
        } as unknown as typeof chrome.permissions,
      }),
    );
    const request = createDefaultRequest({ url: "https://example.com/data" });
    await expect(executeBrowser(request)).rejects.toThrow(
      "permission was not granted",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("encodes non-Latin Basic credentials as UTF-8", async () => {
    let authorization = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL, init: RequestInit) => {
        authorization = (init.headers as Headers).get("Authorization") ?? "";
        return new Response('{"ok":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const request = createDefaultRequest({
      url: "https://example.com/data",
      auth: { kind: "basic", username: "用户", password: "密码" },
    });
    await executeBrowser(request);
    expect(authorization).toBe(
      `Basic ${Buffer.from("用户:密码").toString("base64")}`,
    );
  });

  it("strips custom credentials before following a cross-origin redirect", async () => {
    const forwardedHeaders: Array<string | null> = [];
    const forwardedCredentials: Array<RequestCredentials | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init: RequestInit) => {
        if (url.origin === "https://first.example") {
          return new Response(null, {
            status: 302,
            headers: { location: "https://second.example/result" },
          });
        }
        forwardedHeaders.push((init.headers as Headers).get("X-API-Key"));
        forwardedCredentials.push(init.credentials);
        return new Response("ok", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }),
    );
    const request = createDefaultRequest({
      url: "https://first.example/start",
      headers: [{ name: "X-API-Key", value: "KEY_SECRET", enabled: true }],
    });
    const response = await executeBrowser(request);
    expect(forwardedHeaders).toEqual([null]);
    expect(forwardedCredentials).toEqual(["omit"]);
    expect(response.redirects).toHaveLength(1);
  });

  it("chunks large native request bodies instead of placing them in execute messages", async () => {
    const secret = "large-secret-".repeat(100_000);
    const request = createDefaultRequest({
      method: "POST",
      url: "https://example.com/upload",
      body: { kind: "json", text: JSON.stringify({ secret }) },
    });
    const payload = await prepareNativePayload(request);
    expect(payload.request.body.kind).toBe("file");
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0]?.file.size).toBeGreaterThan(1024 * 1024);
    expect(JSON.stringify(payload.request)).not.toContain(secret.slice(0, 200));
  });

  it("keeps multipart names inside their quoted disposition boundary", async () => {
    const request = createDefaultRequest({
      method: "POST",
      body: {
        kind: "multipart",
        parts: [
          {
            kind: "text",
            name: "unsafe\\",
            value: "value",
            enabled: true,
            headers: [],
          },
        ],
      },
    });
    const payload = await prepareNativePayload(request);
    const body = new TextDecoder().decode(
      await payload.files[0]?.file.arrayBuffer(),
    );
    expect(body).toContain('name="unsafe_"');
    expect(body).not.toContain('name="unsafe\\"');
  });

  it("refuses to replay a body through a cross-origin 307 redirect", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 307,
          headers: { location: "https://second.example/result" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const request = createDefaultRequest({
      method: "POST",
      url: "https://first.example/start",
      body: { kind: "json", text: '{"token":"secret"}' },
    });
    await expect(executeBrowser(request)).rejects.toThrow(
      "attempted to replay the request body",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reports a denied Native Messaging permission", async () => {
    vi.stubGlobal(
      "chrome",
      chromeMock({
        permissions: {
          contains: vi.fn(async () => false),
          request: vi.fn(async () => false),
        } as unknown as typeof chrome.permissions,
      }),
    );
    await expect(executeNative(createDefaultRequest())).rejects.toThrow(
      "Native Messaging permission was not granted",
    );
  });

  it("cancels while the native handshake is still in progress", async () => {
    const messageListeners: Array<(message: unknown) => void> = [];
    const disconnectListeners: Array<() => void> = [];
    const sent: unknown[] = [];
    const port = {
      onMessage: {
        addListener: (listener: (message: unknown) => void) =>
          messageListeners.push(listener),
      },
      onDisconnect: {
        addListener: (listener: () => void) =>
          disconnectListeners.push(listener),
      },
      postMessage: (message: unknown) => sent.push(message),
      disconnect: () => disconnectListeners.forEach((listener) => listener()),
    } as unknown as chrome.runtime.Port;
    vi.stubGlobal(
      "chrome",
      chromeMock({
        runtime: {
          connectNative: vi.fn(() => port),
        } as unknown as typeof chrome.runtime,
      }),
    );
    const request = createDefaultRequest();
    const execution = executeNative(request);
    await Promise.resolve();
    cancelRequest(request.id);
    messageListeners.forEach((listener) =>
      listener({
        version: 1,
        id: crypto.randomUUID(),
        type: "hello",
        client: { name: "test-host", version: "2.0.0" },
        capabilities: [],
      }),
    );
    await expect(execution).rejects.toThrow("cancelled");
    expect(
      sent.filter(
        (message) => (message as { type?: string }).type === "execute",
      ),
    ).toHaveLength(0);
    port.disconnect();
  });
});
