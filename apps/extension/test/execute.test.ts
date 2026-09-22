import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  REMOTE_MAX_RESPONSE_BODY_BYTES,
  createDefaultRequest,
  type ExecutionProgressV1,
} from "@xpanel/contracts";

import {
  browserUnsupportedReasons,
  cancelRequest,
  executeBrowser,
  executeRequest,
  executeRequestStream,
  isRequestCancelling,
  sanitizeBrowserRequestHeaders,
} from "../src/lib/execute";
import { bindFile } from "../src/lib/file-bindings";

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

  it("only verifies Browser permission when access was preflighted", async () => {
    const contains = vi.fn(async () => true);
    const requestPermission = vi.fn(async () => true);
    vi.stubGlobal(
      "chrome",
      chromeMock({ contains, request: requestPermission }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    );

    await executeBrowser(
      createDefaultRequest({ url: "https://example.com/preflighted" }),
      { browserPermissionAlreadyGranted: true },
    );

    expect(contains).toHaveBeenCalledOnce();
    expect(contains).toHaveBeenCalledWith({
      origins: ["https://example.com/*"],
    });
    expect(requestPermission).not.toHaveBeenCalled();
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

  it("aborts and errors a Browser response stream at the configured cap", async () => {
    const maximumResponseBytes = 1024 * 1024;
    const cancel = vi.fn();
    let fetchSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL, init: RequestInit) => {
        fetchSignal = init.signal;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(maximumResponseBytes));
              controller.enqueue(new Uint8Array(1));
            },
            cancel,
          }),
          { status: 200 },
        );
      }),
    );

    await expect(
      executeRequest(
        createDefaultRequest({
          id: "browser-response-cap",
          url: "https://example.com/capped",
        }),
        { maximumResponseBytes },
      ),
    ).rejects.toThrow("configured Browser limit");

    expect(fetchSignal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledWith("response-too-large");
  });

  it("accepts the 20 MiB Browser default boundary and rejects one byte more", async () => {
    const accepted = new Response("ok", {
      status: 200,
      headers: { "Content-Length": String(REMOTE_MAX_RESPONSE_BODY_BYTES) },
    });
    const oversized = new Response("not-read", {
      status: 200,
      headers: {
        "Content-Length": String(REMOTE_MAX_RESPONSE_BODY_BYTES + 1),
      },
    });
    if (!oversized.body) throw new Error("Expected a response stream.");
    const getReader = vi.spyOn(oversized.body, "getReader");
    vi.stubGlobal(
      "fetch",
      vi
        .fn<() => Promise<Response>>()
        .mockResolvedValueOnce(accepted)
        .mockResolvedValueOnce(oversized),
    );

    await expect(
      executeBrowser(
        createDefaultRequest({
          id: "browser-default-cap-boundary",
          url: "https://example.com/boundary",
        }),
      ),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      executeBrowser(
        createDefaultRequest({
          id: "browser-default-cap-overflow",
          url: "https://example.com/overflow",
        }),
      ),
    ).rejects.toThrow("configured Browser limit");
    expect(getReader).not.toHaveBeenCalled();
  });

  it("exposes validated Browser metadata and bytes without materializing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("streamed", {
            status: 201,
            statusText: "Created",
            headers: {
              "Content-Type": "text/plain",
              "Content-Length": "8",
            },
          }),
      ),
    );
    const response = await executeRequestStream(
      createDefaultRequest({
        id: "browser-stream-api",
        url: "https://example.com/stream",
      }),
    );

    expect(response).toMatchObject({
      requestId: "browser-stream-api",
      executor: "browser",
      status: 201,
      statusText: "Created",
      declaredLength: 8,
    });
    expect(response.maximumResponseBytes).toBe(REMOTE_MAX_RESPONSE_BODY_BYTES);
    expect(await new Response(response.stream).text()).toBe("streamed");
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
