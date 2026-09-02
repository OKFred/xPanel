import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  REMOTE_MAX_METADATA_BYTES,
  REMOTE_MAX_REQUEST_BODY_BYTES,
  REMOTE_MAX_RESPONSE_BODY_BYTES,
  createDefaultRequest,
  type ExecutionProgressV1,
  type RemoteRelayProfileV1,
} from "@xpanel/contracts";

import {
  browserUnsupportedReasons,
  cancelRequest,
  executeBrowser,
  executeRemote,
  executeRequest,
  isRequestCancelling,
  remoteUnsupportedReasons,
  sanitizeBrowserRequestHeaders,
} from "../src/lib/execute";
import { bindFile } from "../src/lib/file-bindings";
import { ensureRelayPermission } from "../src/lib/remote-profiles";

function chromeMock(
  overrides: Partial<typeof chrome.permissions> = {},
): typeof chrome {
  return {
    permissions: {
      contains: vi.fn(async () => true),
      request: vi.fn(async () => true),
      ...overrides,
    },
  } as unknown as typeof chrome;
}

function relayProfile(id: string = crypto.randomUUID()): RemoteRelayProfileV1 {
  return {
    schemaVersion: 1,
    id,
    name: `Relay ${id}`,
    baseUrl: "https://relay.example/xpanel",
    tokenStorage: "session",
  };
}

function relayCapabilities(): Record<string, unknown> {
  return {
    protocolVersion: 1,
    provider: "cloudflare",
    targetPolicy: "public-https",
    maxMetadataBytes: REMOTE_MAX_METADATA_BYTES,
    maxRequestBodyBytes: REMOTE_MAX_REQUEST_BODY_BYTES,
    maxResponseBodyBytes: REMOTE_MAX_RESPONSE_BODY_BYTES,
    features: {
      explicitCookie: true,
      responseSetCookie: true,
      files: true,
      multipart: true,
      proxy: false,
      customTls: false,
      clientCertificate: false,
    },
  };
}

function encodeRelayMetadata(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeRelayMetadata(value: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

function relaySuccess(
  requestId: string,
  body = "ok",
  overrides: Record<string, unknown> = {},
): Response {
  const metadata = {
    protocolVersion: 1,
    requestId,
    status: 200,
    statusText: "OK",
    headers: [{ name: "Content-Type", value: "text/plain" }],
    redirects: [],
    upstreamDurationMs: 3,
    declaredBodySizeBytes: new TextEncoder().encode(body).byteLength,
    warnings: [],
    ...overrides,
  };
  return new Response(body, {
    status: 200,
    headers: { "X-XPanel-Response": encodeRelayMetadata(metadata) },
  });
}

function relayFetch(
  execute: (url: URL, init: RequestInit) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: URL, init: RequestInit) => {
    if (url.pathname.endsWith("/v1/capabilities")) {
      return new Response(JSON.stringify(relayCapabilities()), { status: 200 });
    }
    return execute(url, init);
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal("chrome", chromeMock());
});

describe("Browser execution", () => {
  it("keeps ordinary requests in Fetch", () => {
    expect(
      browserUnsupportedReasons(
        createDefaultRequest({ url: "https://example.com" }),
      ),
    ).toEqual([]);
  });

  it("refuses unsupported features instead of silently dropping them", async () => {
    const request = createDefaultRequest({
      url: "https://example.com",
      headers: [{ name: "Cookie", value: "session=secret", enabled: true }],
    });
    request.options.proxy = { url: "http://127.0.0.1:8080", bypass: [] };
    request.options.tls.verify = false;

    await expect(executeRequest(request)).rejects.toThrow(
      /explicit proxy.*disabled TLS.*forbidden Cookie header/,
    );
    expect(chrome.permissions.request).not.toHaveBeenCalled();
  });

  it("rejects Proxy-, Sec-, and browser-forbidden header names", () => {
    for (const name of ["Proxy-Connection", "Sec-Example", "Cookie2"]) {
      const request = createDefaultRequest({
        headers: [{ name, value: "value", enabled: true }],
      });
      expect(browserUnsupportedReasons(request)).toContain(
        `the forbidden ${name} header`,
      );
    }
  });

  it("sanitizes enabled forbidden regular headers for Browser Fetch", () => {
    const request = createDefaultRequest({
      headers: [
        { name: "DNT", value: "1", enabled: true },
        { name: "Origin", value: "https://source.example", enabled: true },
        {
          name: "Referer",
          value: "https://source.example/page",
          enabled: true,
        },
        { name: "sec-ch-ua", value: '"Chromium"', enabled: true },
        { name: "SEC-CH-UA", value: '"duplicate"', enabled: true },
        { name: "sec-ch-ua-mobile", value: "?0", enabled: true },
        {
          name: "sec-ch-ua-platform",
          value: '"Windows"',
          enabled: true,
        },
        { name: "sec-fetch-dest", value: "empty", enabled: true },
        { name: "sec-fetch-mode", value: "cors", enabled: true },
        { name: "sec-fetch-site", value: "same-origin", enabled: true },
        { name: "X-Trace", value: "trace", enabled: true },
        { name: "Cookie", value: "session=secret", enabled: true },
        { name: "Host", value: "example.com", enabled: true },
        { name: "Set-Cookie", value: "session=ignored", enabled: true },
        { name: "X-HTTP-Method-Override", value: "TRACE", enabled: true },
        { name: "X-Method-Override", value: "PATCH", enabled: true },
        {
          name: "Permissions-Policy",
          value: "geolocation=()",
          enabled: true,
        },
      ],
    });

    const result = sanitizeBrowserRequestHeaders(request);

    expect(result.request.headers).toEqual([
      { name: "X-Trace", value: "trace", enabled: true },
      { name: "X-Method-Override", value: "PATCH", enabled: true },
      {
        name: "Permissions-Policy",
        value: "geolocation=()",
        enabled: true,
      },
    ]);
    expect(result.removedHeaders).toEqual([
      { name: "DNT", occurrences: 1 },
      { name: "Origin", occurrences: 1 },
      { name: "Referer", occurrences: 1 },
      { name: "sec-ch-ua", occurrences: 2 },
      { name: "sec-ch-ua-mobile", occurrences: 1 },
      { name: "sec-ch-ua-platform", occurrences: 1 },
      { name: "sec-fetch-dest", occurrences: 1 },
      { name: "sec-fetch-mode", occurrences: 1 },
      { name: "sec-fetch-site", occurrences: 1 },
      { name: "Cookie", occurrences: 1 },
      { name: "Host", occurrences: 1 },
      { name: "Set-Cookie", occurrences: 1 },
      { name: "X-HTTP-Method-Override", occurrences: 1 },
    ]);
  });

  it("returns a plain clone, preserves disabled headers, and does not mutate input", () => {
    const request = createDefaultRequest({
      headers: [
        { name: " DNT ", value: "1", enabled: true },
        { name: "Origin", value: "disabled", enabled: false },
        { name: "X-Trace", value: "trace", enabled: true },
      ],
    });
    const original = structuredClone(request);

    const result = sanitizeBrowserRequestHeaders(request);

    expect(request).toEqual(original);
    expect(result.request).not.toBe(request);
    expect(result.request.headers).not.toBe(request.headers);
    expect(() => structuredClone(result.request)).not.toThrow();
    expect(result.request.headers).toEqual([
      { name: "Origin", value: "disabled", enabled: false },
      { name: "X-Trace", value: "trace", enabled: true },
    ]);
    expect(result.removedHeaders).toEqual([{ name: "DNT", occurrences: 1 }]);
  });

  it("does not hide unsupported auth or proxy features", () => {
    const request = createDefaultRequest({
      headers: [{ name: "DNT", value: "1", enabled: true }],
      auth: {
        kind: "api-key",
        location: "header",
        name: "Cookie",
        value: "session=secret",
      },
    });
    request.options.proxy = { url: "http://127.0.0.1:8080", bypass: [] };

    const result = sanitizeBrowserRequestHeaders(request);

    expect(result.request.auth).toEqual(request.auth);
    expect(result.request.options.proxy).toEqual(request.options.proxy);
    expect(browserUnsupportedReasons(result.request)).toEqual([
      "an explicit proxy",
      "the forbidden Cookie header",
    ]);
  });

  it("rejects custom multipart part headers", () => {
    const request = createDefaultRequest({
      body: {
        kind: "multipart",
        parts: [
          {
            kind: "text",
            name: "metadata",
            value: "{}",
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
    expect(browserUnsupportedReasons(request)).toContain(
      "custom multipart part headers",
    );
  });

  it("requests host access directly and reports denial before fetching", async () => {
    const fetchMock = vi.fn();
    const contains = vi.fn(async () => false);
    const requestPermission = vi.fn(async () => false);
    vi.stubGlobal(
      "chrome",
      chromeMock({ contains, request: requestPermission }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      executeBrowser(createDefaultRequest({ url: "https://example.com/data" })),
    ).rejects.toThrow("permission was not granted");
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(contains).not.toHaveBeenCalled();
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

  it("keeps a Browser response without Content-Type as base64", async () => {
    const bytes = new Uint8Array([0, 255, 1, 128]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(bytes, { status: 200 })),
    );

    const response = await executeBrowser(
      createDefaultRequest({
        id: "browser-untyped-binary",
        url: "https://example.com/binary",
      }),
    );

    expect(response.body).toEqual({
      kind: "inline",
      encoding: "base64",
      content: Buffer.from(bytes).toString("base64"),
      sizeBytes: bytes.byteLength,
    });
  });

  it("binds request files without buffering their contents", async () => {
    const file = new File(["large-placeholder"], "large.bin", {
      type: "application/octet-stream",
    });
    const read = vi.spyOn(file, "arrayBuffer");

    const reference = bindFile(
      {
        id: crypto.randomUUID(),
        name: "Select a file",
        requiresReselection: true,
      },
      file,
    );

    expect(read).not.toHaveBeenCalled();
    expect(reference).toMatchObject({
      name: "large.bin",
      size: file.size,
      requiresReselection: false,
    });
    expect(reference.sha256).toBeUndefined();
  });

  it("sends a selected raw file through Fetch", async () => {
    const originalReference = {
      id: crypto.randomUUID(),
      name: "payload.bin",
      requiresReselection: true,
    };
    const file = new File(["raw-payload"], "payload.bin", {
      type: "application/octet-stream",
    });
    const reference = bindFile(originalReference, file);
    let capturedBody: BodyInit | null | undefined;
    let capturedType: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL, init: RequestInit) => {
        capturedBody = init.body;
        capturedType = (init.headers as Headers).get("Content-Type");
        return new Response("ok", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }),
    );

    await executeBrowser(
      createDefaultRequest({
        method: "POST",
        url: "https://example.com/upload",
        body: { kind: "file", file: reference },
      }),
    );

    expect(capturedBody).toBe(file);
    expect(capturedType).toBe("application/octet-stream");
  });

  it("sends selected multipart files and lets Fetch set the boundary", async () => {
    const originalReference = {
      id: crypto.randomUUID(),
      name: "avatar.txt",
      requiresReselection: true,
    };
    const file = new File(["avatar"], "avatar.txt", { type: "text/plain" });
    const reference = bindFile(originalReference, file);
    let capturedBody: FormData | undefined;
    let contentType: string | null = "not-captured";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL, init: RequestInit) => {
        capturedBody = init.body as FormData;
        contentType = (init.headers as Headers).get("Content-Type");
        return new Response("ok", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }),
    );

    const response = await executeBrowser(
      createDefaultRequest({
        method: "POST",
        url: "https://example.com/upload",
        headers: [
          {
            name: "Content-Type",
            value: "multipart/form-data; boundary=wrong",
            enabled: true,
          },
        ],
        body: {
          kind: "multipart",
          parts: [
            {
              kind: "text",
              name: "label",
              value: "profile",
              enabled: true,
              headers: [],
            },
            {
              kind: "file",
              name: "avatar",
              file: reference,
              enabled: true,
              headers: [],
            },
          ],
        },
      }),
    );

    expect(capturedBody?.get("label")).toBe("profile");
    const uploaded = capturedBody?.get("avatar") as File;
    expect(uploaded.name).toBe(file.name);
    expect(await uploaded.text()).toBe("avatar");
    expect(contentType).toBeNull();
    expect(response.warnings).toContainEqual(
      expect.objectContaining({ code: "browser-multipart-content-type" }),
    );
  });

  it("requires imported files to be selected again before permission prompts", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const request = createDefaultRequest({
      method: "POST",
      url: "https://example.com/upload",
      body: {
        kind: "file",
        file: {
          id: crypto.randomUUID(),
          name: "secret.bin",
          requiresReselection: true,
        },
      },
    });

    await expect(executeBrowser(request)).rejects.toThrow(
      "must be selected again",
    );
    expect(chrome.permissions.request).not.toHaveBeenCalled();
  });

  it("strips credentials before following a cross-origin redirect", async () => {
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

  it("cancels an active Fetch request", async () => {
    const fetchMock = vi.fn(
      async (_url: URL, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const request = createDefaultRequest({
      id: crypto.randomUUID(),
      url: "https://example.com/slow",
    });
    const execution = executeRequest(request);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    cancelRequest(request.id);

    await expect(execution).rejects.toThrow("Request cancelled");
  });

  it("arms Browser Fetch with the request timeout", async () => {
    const timeoutSpy = vi.spyOn(window, "setTimeout");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    );
    const request = createDefaultRequest({
      id: crypto.randomUUID(),
      url: "https://example.com/timeout",
    });

    await executeBrowser(request);

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
  });

  it("remembers cancellation while a host permission prompt is pending", async () => {
    let resolvePermission!: (granted: boolean) => void;
    const requestPermission = vi.fn(
      async () =>
        new Promise<boolean>((resolve) => {
          resolvePermission = resolve;
        }),
    );
    vi.stubGlobal("chrome", chromeMock({ request: requestPermission }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const request = createDefaultRequest({
      id: crypto.randomUUID(),
      url: "https://example.com/pending-permission",
    });
    const execution = executeBrowser(request);
    await vi.waitFor(() => expect(requestPermission).toHaveBeenCalledOnce());

    cancelRequest(request.id);
    resolvePermission(true);

    await expect(execution).rejects.toThrow("Request cancelled");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Remote execution", () => {
  it("requests relay permission once, then only verifies it during execute", async () => {
    const contains = vi.fn(async () => true);
    const requestPermission = vi.fn(async () => true);
    vi.stubGlobal(
      "chrome",
      chromeMock({ contains, request: requestPermission }),
    );
    const request = createDefaultRequest({
      id: "preflighted-relay-permission",
      url: "https://api.example/items",
    });
    const profile = relayProfile("preflighted-relay-permission");
    vi.stubGlobal(
      "fetch",
      relayFetch(async () => relaySuccess(request.id)),
    );

    await ensureRelayPermission(profile);
    await executeRemote(
      request,
      { kind: "remote", profile, token: "relay-token" },
      { relayPermissionAlreadyGranted: true },
    );

    expect(requestPermission).toHaveBeenCalledOnce();
    expect(requestPermission).toHaveBeenCalledWith({
      origins: ["https://relay.example/*"],
    });
    expect(contains).toHaveBeenCalledOnce();
    expect(contains).toHaveBeenCalledWith({
      origins: ["https://relay.example/*"],
    });
  });

  it("sends Browser-controlled application headers through the versioned wire protocol", async () => {
    const request = createDefaultRequest({
      method: "POST",
      url: "https://api.example/items?existing=1",
      query: [{ name: "added", value: "two", enabled: true }],
      headers: [
        { name: "Cookie", value: "session=secret", enabled: true },
        { name: "Origin", value: "https://source.example", enabled: true },
        {
          name: "Referer",
          value: "https://source.example/page",
          enabled: true,
        },
        { name: "DNT", value: "1", enabled: true },
        { name: "Sec-Example", value: "preserved", enabled: true },
      ],
      auth: { kind: "bearer", token: "target-token" },
      body: { kind: "json", text: '{"ok":true}' },
    });
    const progress: ExecutionProgressV1[] = [];
    let metadata: Record<string, unknown> | undefined;
    let uploaded = "";
    const fetchMock = relayFetch(async (url, init) => {
      expect(url.toString()).toBe("https://relay.example/xpanel/v1/execute");
      const outerHeaders = init.headers as Record<string, string>;
      expect(outerHeaders.Authorization).toBe("Bearer relay-token");
      expect(outerHeaders["X-XPanel-Protocol"]).toBe("1");
      metadata = decodeRelayMetadata(outerHeaders["X-XPanel-Request"]!);
      expect(init.body).toBeInstanceOf(Blob);
      uploaded = await (init.body as Blob).text();
      return relaySuccess(request.id, "not found", {
        status: 404,
        statusText: "Not Found",
        headers: [
          { name: "Content-Type", value: "text/plain" },
          { name: "Set-Cookie", value: "sid=next; HttpOnly" },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await executeRequest(request, {
      target: {
        kind: "remote",
        profile: relayProfile("wire-protocol"),
        token: "relay-token",
      },
      onProgress: (value) => progress.push(value),
    });

    expect(metadata).toMatchObject({
      protocolVersion: 1,
      requestId: request.id,
      method: "POST",
      url: "https://api.example/items?existing=1&added=two",
      redirect: "follow",
      timeoutMs: 60_000,
      bodySizeBytes: 11,
    });
    expect(metadata?.headers).toEqual(
      expect.arrayContaining([
        { name: "Cookie", value: "session=secret" },
        { name: "Origin", value: "https://source.example" },
        { name: "Referer", value: "https://source.example/page" },
        { name: "DNT", value: "1" },
        { name: "Sec-Example", value: "preserved" },
        { name: "Authorization", value: "Bearer target-token" },
        { name: "Content-Type", value: "application/json" },
      ]),
    );
    expect(JSON.stringify(metadata)).not.toContain("relay-token");
    expect(uploaded).toBe('{"ok":true}');
    expect(response).toMatchObject({ executor: "remote", status: 404 });
    expect(response.headers).toContainEqual(
      expect.objectContaining({
        name: "Set-Cookie",
        value: "sid=next; HttpOnly",
      }),
    );
    expect(response.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "remote-cookie-mode-not-applied" }),
        expect.objectContaining({ code: "remote-cookies-not-applied" }),
      ]),
    );
    expect(progress.map((value) => value.phase)).toEqual(
      expect.arrayContaining([
        "preparing",
        "requesting-permission",
        "uploading",
        "downloading",
        "complete",
      ]),
    );
    expect(progress.find((value) => value.phase === "uploading")).toMatchObject(
      { loadedBytes: 0, totalBytes: 11 },
    );
    expect(progress.map((value) => value.phase)).not.toContain("waiting");
  });

  it("keeps a selected file as the upload body without buffering it", async () => {
    const file = new File([new Uint8Array([0, 1, 2, 255])], "payload.bin", {
      type: "application/octet-stream",
    });
    const arrayBuffer = vi.spyOn(file, "arrayBuffer");
    const reference = bindFile(
      {
        id: crypto.randomUUID(),
        name: "Select a file",
        requiresReselection: true,
      },
      file,
    );
    const request = createDefaultRequest({
      id: "remote-file-stream",
      method: "POST",
      url: "https://api.example/upload",
      body: { kind: "file", file: reference },
    });
    let uploadedBody: BodyInit | null | undefined;
    vi.stubGlobal(
      "fetch",
      relayFetch(async (_url, init) => {
        uploadedBody = init.body;
        return relaySuccess(request.id);
      }),
    );

    await executeRemote(request, {
      kind: "remote",
      profile: relayProfile("file-stream"),
      token: "secret",
    });

    expect(uploadedBody).toBe(file);
    expect(uploadedBody).toBeInstanceOf(File);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("rejects transport headers and local-only network options before permissions", async () => {
    const request = createDefaultRequest({
      url: "https://api.example",
      headers: [
        { name: "Host", value: "other.example", enabled: true },
        { name: "Content-Length", value: "5", enabled: true },
        { name: "Set-Cookie", value: "request=value", enabled: true },
      ],
    });
    request.options.proxy = { url: "http://proxy.example:8080", bypass: [] };

    expect(remoteUnsupportedReasons(request)).toEqual(
      expect.arrayContaining([
        "an explicit proxy",
        "the unsupported Host header",
        "the unsupported Content-Length header",
        "the unsupported Set-Cookie header",
      ]),
    );
    await expect(
      executeRemote(request, {
        kind: "remote",
        profile: relayProfile(),
        token: "secret",
      }),
    ).rejects.toThrow("cannot preserve");
    expect(chrome.permissions.request).not.toHaveBeenCalled();
  });

  it("materializes selected raw and multipart files with a deterministic boundary", async () => {
    const file = new File(["file-body"], "payload.txt", { type: "text/plain" });
    const reference = bindFile(
      {
        id: crypto.randomUUID(),
        name: "Select a file",
        requiresReselection: true,
      },
      file,
    );
    const request = createDefaultRequest({
      id: "deterministic-multipart",
      method: "POST",
      url: "https://api.example/upload",
      options: {
        redirect: "follow",
        cookieMode: "omit",
        timeoutMs: 60_000,
        proxy: null,
        tls: { verify: true },
      },
      body: {
        kind: "multipart",
        parts: [
          {
            kind: "text",
            name: "label",
            value: "profile",
            enabled: true,
            headers: [{ name: "X-Part", value: "one", enabled: true }],
          },
          {
            kind: "file",
            name: "upload",
            file: reference,
            enabled: true,
            headers: [],
          },
        ],
      },
    });
    const bodies: string[] = [];
    const contentTypes: string[] = [];
    vi.stubGlobal(
      "fetch",
      relayFetch(async (_url, init) => {
        const outer = init.headers as Record<string, string>;
        const metadata = decodeRelayMetadata(outer["X-XPanel-Request"]!);
        const headers = metadata.headers as Array<{
          name: string;
          value: string;
        }>;
        contentTypes.push(
          headers.find((header) => header.name === "Content-Type")?.value ?? "",
        );
        bodies.push(await (init.body as Blob).text());
        return relaySuccess(request.id);
      }),
    );

    const target = {
      kind: "remote" as const,
      profile: relayProfile("multipart"),
      token: "secret",
    };
    await executeRemote(request, target);
    await executeRemote(request, target);

    expect(contentTypes[0]).toMatch(
      /^multipart\/form-data; boundary=----xpanel-/u,
    );
    expect(contentTypes[1]).toBe(contentTypes[0]);
    expect(bodies[1]).toBe(bodies[0]);
    expect(bodies[0]).toContain("X-Part: one\r\n");
    expect(bodies[0]).toContain('name="label"');
    expect(bodies[0]).toContain('filename="payload.txt"');
    expect(bodies[0]).toContain("file-body");
  });

  it("enforces request metadata and body limits before execute transport", async () => {
    const oversizedMetadata = createDefaultRequest({
      id: "oversized-metadata",
      method: "POST",
      url: "https://api.example",
      headers: [
        {
          name: "X-Large",
          value: "x".repeat(REMOTE_MAX_METADATA_BYTES),
          enabled: true,
        },
      ],
    });
    const oversizedBody = createDefaultRequest({
      id: "oversized-body",
      method: "POST",
      url: "https://api.example",
      body: {
        kind: "text",
        text: "x".repeat(REMOTE_MAX_REQUEST_BODY_BYTES + 1),
      },
    });
    const fetchMock = relayFetch(async () => relaySuccess("unused"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      executeRemote(oversizedMetadata, {
        kind: "remote",
        profile: relayProfile("metadata-limit"),
        token: "secret",
      }),
    ).rejects.toThrow("metadata exceeds 48 KiB");
    await expect(
      executeRemote(oversizedBody, {
        kind: "remote",
        profile: relayProfile("body-limit"),
        token: "secret",
      }),
    ).rejects.toThrow("body exceeds the 20 MiB");
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        (url as URL).pathname.endsWith("/v1/execute"),
      ),
    ).toHaveLength(0);
  });

  it("rejects an oversized outer Content-Length before reading the body", async () => {
    const request = createDefaultRequest({
      id: "oversized-response",
      url: "https://api.example",
    });
    const response = new Response("tiny", {
      status: 200,
      headers: {
        "Content-Length": String(REMOTE_MAX_RESPONSE_BODY_BYTES + 1),
        "X-XPanel-Response": encodeRelayMetadata({
          protocolVersion: 1,
          requestId: request.id,
          status: 200,
          statusText: "OK",
          headers: [],
          redirects: [],
          upstreamDurationMs: 1,
          warnings: [],
        }),
      },
    });
    if (!response.body) throw new Error("Expected a response stream.");
    const getReader = vi.spyOn(response.body, "getReader");
    const arrayBuffer = vi.spyOn(response, "arrayBuffer");
    vi.stubGlobal(
      "fetch",
      relayFetch(async () => response),
    );

    await expect(
      executeRemote(request, {
        kind: "remote",
        profile: relayProfile("response-limit"),
        token: "secret",
      }),
    ).rejects.toThrow("Response body exceeds the 20 MiB");
    expect(getReader).not.toHaveBeenCalled();
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("maps an unknown-length Relay stream overflow to the Remote size limit", async () => {
    const request = createDefaultRequest({
      id: "streamed-response-limit",
      url: "https://api.example",
    });
    let sentLimit = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sentLimit) {
          sentLimit = true;
          controller.enqueue(new Uint8Array(REMOTE_MAX_RESPONSE_BODY_BYTES));
          return;
        }
        controller.error(new Error("transport terminated"));
      },
    });
    vi.stubGlobal(
      "fetch",
      relayFetch(
        async () =>
          new Response(stream, {
            headers: {
              "X-XPanel-Response": encodeRelayMetadata({
                protocolVersion: 1,
                requestId: request.id,
                status: 200,
                statusText: "OK",
                headers: [],
                redirects: [],
                upstreamDurationMs: 1,
                warnings: [],
              }),
            },
          }),
      ),
    );

    await expect(
      executeRemote(request, {
        kind: "remote",
        profile: relayProfile("streamed-response-limit"),
        token: "secret",
      }),
    ).rejects.toThrow("Response body exceeds the 20 MiB Remote limit");
  });

  it("keeps a response without Content-Type as base64", async () => {
    const request = createDefaultRequest({
      id: "remote-untyped-binary",
      url: "https://api.example/binary",
    });
    const bytes = new Uint8Array([0, 255, 1, 128]);
    vi.stubGlobal(
      "fetch",
      relayFetch(
        async () =>
          new Response(bytes, {
            status: 200,
            headers: {
              "X-XPanel-Response": encodeRelayMetadata({
                protocolVersion: 1,
                requestId: request.id,
                status: 200,
                statusText: "OK",
                headers: [],
                redirects: [],
                upstreamDurationMs: 1,
                declaredBodySizeBytes: bytes.byteLength,
                warnings: [],
              }),
            },
          }),
      ),
    );

    const response = await executeRemote(request, {
      kind: "remote",
      profile: relayProfile("untyped-binary"),
      token: "secret",
    });

    expect(response.body).toEqual({
      kind: "inline",
      encoding: "base64",
      content: Buffer.from(bytes).toString("base64"),
      sizeBytes: bytes.byteLength,
    });
  });

  it("stream-rejects oversized non-200 relay error metadata", async () => {
    const request = createDefaultRequest({
      id: "oversized-relay-error",
      url: "https://api.example",
    });
    const cancel = vi.fn();
    const oversized = new Uint8Array(REMOTE_MAX_METADATA_BYTES + 1);
    oversized.fill(120);
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(oversized.subarray(0, REMOTE_MAX_METADATA_BYTES));
          controller.enqueue(oversized.subarray(REMOTE_MAX_METADATA_BYTES));
        },
        cancel,
      }),
      { status: 400 },
    );
    const arrayBuffer = vi.spyOn(response, "arrayBuffer");
    vi.stubGlobal(
      "fetch",
      relayFetch(async () => response),
    );

    await expect(
      executeRemote(request, {
        kind: "remote",
        profile: relayProfile("oversized-error"),
        token: "secret",
      }),
    ).rejects.toThrow("Remote relay failed with HTTP 400");

    expect(cancel).toHaveBeenCalledWith("metadata-too-large");
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});

describe("Unified progress and cancellation", () => {
  it("streams Browser download progress and does not claim upload completion", async () => {
    const encoder = new TextEncoder();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(encoder.encode("one"));
                controller.enqueue(encoder.encode("two"));
                controller.close();
              },
            }),
            {
              headers: { "Content-Type": "text/plain", "Content-Length": "6" },
            },
          ),
      ),
    );
    const progress: ExecutionProgressV1[] = [];
    const request = createDefaultRequest({
      method: "POST",
      url: "https://example.com/progress",
      body: { kind: "text", text: "request" },
    });

    await executeBrowser(request, {
      onProgress: (value) => progress.push(value),
    });

    expect(progress.find((value) => value.phase === "uploading")).toMatchObject(
      {
        loadedBytes: 0,
        totalBytes: 7,
      },
    );
    expect(
      progress
        .filter((value) => value.phase === "downloading")
        .map((value) => value.loadedBytes),
    ).toEqual([0, 3, 6]);
  });

  it("preserves byte progress while cancelling and never returns a late success", async () => {
    const encoder = new TextEncoder();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                streamController = controller;
                controller.enqueue(encoder.encode("part"));
              },
            }),
            {
              headers: { "Content-Type": "text/plain", "Content-Length": "8" },
            },
          ),
      ),
    );
    const request = createDefaultRequest({
      id: "late-browser-cancel",
      url: "https://example.com/slow-response",
    });
    const progress: ExecutionProgressV1[] = [];
    const execution = executeBrowser(request, {
      onProgress: (value) => progress.push(value),
    });
    await vi.waitFor(() =>
      expect(progress).toContainEqual(
        expect.objectContaining({ phase: "downloading", loadedBytes: 4 }),
      ),
    );

    expect(cancelRequest(request.id)).toBe(true);
    expect(isRequestCancelling(request.id)).toBe(true);
    expect(progress.at(-1)).toMatchObject({
      phase: "cancelling",
      loadedBytes: 4,
      totalBytes: 8,
    });
    streamController.close();

    await expect(execution).rejects.toThrow("Request cancelled");
    expect(isRequestCancelling(request.id)).toBe(false);
  });
});
