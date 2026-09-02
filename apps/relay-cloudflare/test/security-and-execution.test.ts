import type { RelayHeaderV1 } from "@xpanel/contracts";
import { describe, expect, test, vi } from "vitest";

import type { Fetcher } from "../src/executor";
import {
  createEnv,
  createMetadata,
  executeRelay,
  readRelayError,
  readResponseMetadata,
  toArrayBuffer,
} from "./helpers";

describe("target policy and SSRF controls", () => {
  test("an allowlist accepts only an exact configured origin", async () => {
    const fetcher = vi.fn<Fetcher>(() => Promise.resolve(new Response("ok")));
    const allowed = await executeRelay(
      fetcher,
      createMetadata({ url: "https://api.example.com:8443/path" }),
      new Uint8Array(),
      createEnv({
        ALLOWED_TARGET_ORIGINS: "https://api.example.com:8443",
      }),
    );
    const denied = await executeRelay(
      fetcher,
      createMetadata({ url: "https://api.example.com/path" }),
      new Uint8Array(),
      createEnv({
        ALLOWED_TARGET_ORIGINS: "https://api.example.com:8443",
      }),
    );

    expect(allowed.status).toBe(200);
    expect(denied.status).toBe(403);
    await expect(readRelayError(denied)).resolves.toMatchObject({
      requestId: "request-1",
      error: { code: "target_not_allowed" },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("public-https allows public default-port HTTPS targets", async () => {
    const fetcher = vi.fn<Fetcher>(() => Promise.resolve(new Response("ok")));
    const response = await executeRelay(
      fetcher,
      createMetadata({ url: "https://public.example.net/path" }),
      new Uint8Array(),
      createEnv({
        TARGET_POLICY: "public-https",
        ALLOWED_TARGET_ORIGINS: "",
      }),
    );

    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  test("public-https rejects a non-default port unless that exact origin is allowlisted", async () => {
    const target = "https://public.example.net:8443/path";
    const fetcher = vi.fn<Fetcher>(() => Promise.resolve(new Response("ok")));
    const denied = await executeRelay(
      fetcher,
      createMetadata({ url: target }),
      new Uint8Array(),
      createEnv({
        TARGET_POLICY: "public-https",
        ALLOWED_TARGET_ORIGINS: "",
      }),
    );
    const allowed = await executeRelay(
      fetcher,
      createMetadata({ url: target }),
      new Uint8Array(),
      createEnv({
        TARGET_POLICY: "public-https",
        ALLOWED_TARGET_ORIGINS: "https://public.example.net:8443",
      }),
    );

    expect(denied.status).toBe(403);
    expect((await readRelayError(denied)).error.code).toBe(
      "target_not_allowed",
    );
    expect(allowed.status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  test.each([
    "http://public.example.net/path",
    "https://user:password@public.example.net/path",
    "https://localhost/path",
    "https://localhost.localdomain/path",
    "https://metadata.google.internal/path",
    "https://service.internal/path",
    "https://printer.local/path",
    "https://127.0.0.1/path",
    "https://10.0.0.1/path",
    "https://[::1]/path",
    "https://relay.example.workers.dev/path",
    "https://relay.example.workers.dev./path",
  ])("blocks SSRF target %s even in public-https mode", async (url) => {
    const fetcher = vi.fn<Fetcher>();
    const response = await executeRelay(
      fetcher,
      createMetadata({ url }),
      new Uint8Array(),
      createEnv({
        TARGET_POLICY: "public-https",
        ALLOWED_TARGET_ORIGINS: "",
      }),
    );

    expect(response.status).toBe(403);
    await expect(readRelayError(response)).resolves.toMatchObject({
      requestId: "request-1",
      error: { code: "target_not_allowed" },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("blocks every configured Relay alias", async () => {
    const fetcher = vi.fn<Fetcher>();
    const response = await executeRelay(
      fetcher,
      createMetadata({ url: "https://relay.example.com/path" }),
      new Uint8Array(),
      createEnv({
        TARGET_POLICY: "public-https",
        ALLOWED_TARGET_ORIGINS: "",
        RELAY_SELF_ORIGINS: "https://relay.example.com",
      }),
    );

    expect(response.status).toBe(403);
    await expect(readRelayError(response)).resolves.toMatchObject({
      requestId: "request-1",
      error: { code: "target_not_allowed" },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("fails closed when the target policy configuration is invalid", async () => {
    const fetcher = vi.fn<Fetcher>();
    const response = await executeRelay(
      fetcher,
      createMetadata(),
      new Uint8Array(),
      createEnv({ TARGET_POLICY: "everything" }),
    );

    expect(response.status).toBe(500);
    await expect(readRelayError(response)).resolves.toMatchObject({
      error: { code: "internal" },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("application headers and raw request bodies", () => {
  test("forwards explicit Cookie, Authorization, DNT, Origin, Referer, and Sec-* headers", async () => {
    const headers: RelayHeaderV1[] = [
      { name: "Cookie", value: "session=target-cookie" },
      { name: "Authorization", value: "Bearer target-token" },
      { name: "DNT", value: "1" },
      { name: "Origin", value: "https://caller.example" },
      { name: "Referer", value: "https://caller.example/page" },
      { name: "Sec-CH-UA", value: '"Chromium";v="140"' },
      { name: "Sec-Fetch-Site", value: "cross-site" },
    ];
    let forwarded: Headers | undefined;
    let forwardedInit: RequestInit | undefined;
    const fetcher: Fetcher = (_input, init) => {
      forwardedInit = init;
      forwarded = new Headers(init?.headers);
      return Promise.resolve(new Response("ok"));
    };

    const response = await executeRelay(fetcher, createMetadata({ headers }));

    expect(response.status).toBe(200);
    expect(forwarded?.get("cookie")).toBe("session=target-cookie");
    expect(forwarded?.get("authorization")).toBe("Bearer target-token");
    expect(forwarded?.get("dnt")).toBe("1");
    expect(forwarded?.get("origin")).toBe("https://caller.example");
    expect(forwarded?.get("referer")).toBe("https://caller.example/page");
    expect(forwarded?.get("sec-ch-ua")).toBe('"Chromium";v="140"');
    expect(forwarded?.get("sec-fetch-site")).toBe("cross-site");
    expect(forwardedInit?.cf?.cacheTtlByStatus).toEqual({
      "100-599": -1,
    });
  });

  test.each([
    "Host",
    "Content-Length",
    "Connection",
    "Keep-Alive",
    "Transfer-Encoding",
    "TE",
    "Trailer",
    "Upgrade",
    "Proxy-Authorization",
    "Proxy-Whatever",
    "Set-Cookie",
    "CF-Ray",
    "X-XPanel-Response",
    "X-Forwarded-For",
  ])("rejects relay-controlled request header %s", async (name) => {
    const fetcher = vi.fn<Fetcher>();
    const response = await executeRelay(
      fetcher,
      createMetadata({ headers: [{ name, value: "untrusted" }] }),
    );

    expect(response.status).toBe(400);
    await expect(readRelayError(response)).resolves.toMatchObject({
      requestId: "request-1",
      error: { code: "unsupported_header" },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("passes multipart or file payload bytes through without parsing or executing them", async () => {
    const body = new TextEncoder().encode(
      '--xpanel-boundary\r\nContent-Disposition: form-data; name="file"; filename="payload.bin"\r\nContent-Type: application/octet-stream\r\n\r\n$(touch /tmp/must-not-run)\0binary\r\n--xpanel-boundary--\r\n',
    );
    let forwardedBody: Uint8Array | undefined;
    let forwardedContentType: string | null = null;
    const fetcher: Fetcher = async (_input, init) => {
      forwardedContentType = new Headers(init?.headers).get("content-type");
      forwardedBody = new Uint8Array(
        await new Response(init?.body).arrayBuffer(),
      );
      return new Response("accepted");
    };
    const response = await executeRelay(
      fetcher,
      createMetadata({
        method: "POST",
        headers: [
          {
            name: "Content-Type",
            value: "multipart/form-data; boundary=xpanel-boundary",
          },
        ],
        bodySizeBytes: body.byteLength,
      }),
      body,
    );

    expect(response.status).toBe(200);
    expect(forwardedContentType).toBe(
      "multipart/form-data; boundary=xpanel-boundary",
    );
    expect(forwardedBody).toEqual(body);
  });

  test.each(["GET", "HEAD"])(
    "rejects a request body for %s",
    async (method) => {
      const body = new TextEncoder().encode("unexpected body");
      const fetcher = vi.fn<Fetcher>();
      const response = await executeRelay(
        fetcher,
        createMetadata({
          method,
          bodySizeBytes: body.byteLength,
        }),
        body,
      );

      expect(response.status).toBe(400);
      await expect(readRelayError(response)).resolves.toMatchObject({
        error: { code: "unsupported_request" },
      });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  test.each(["CONNECT", "TRACE", "TRACK"])(
    "rejects unsupported method %s",
    async (method) => {
      const fetcher = vi.fn<Fetcher>();
      const response = await executeRelay(fetcher, createMetadata({ method }));

      expect(response.status).toBe(400);
      await expect(readRelayError(response)).resolves.toMatchObject({
        error: { code: "unsupported_request" },
      });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
});

describe("successful response envelope", () => {
  test("keeps target 4xx as an outer HTTP 200 response", async () => {
    const fetcher: Fetcher = () =>
      Promise.resolve(
        new Response("not found", {
          status: 404,
          statusText: "Not Found",
          headers: { "Content-Length": "9", "X-Upstream": "yes" },
        }),
      );
    const response = await executeRelay(fetcher);
    const metadata = readResponseMetadata(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(
      "not found",
    );
    expect(metadata).toMatchObject({
      protocolVersion: 1,
      requestId: "request-1",
      status: 404,
      statusText: "Not Found",
      redirects: [],
      declaredBodySizeBytes: 9,
      warnings: [],
    });
    expect(metadata.headers).toContainEqual({
      name: "x-upstream",
      value: "yes",
    });
  });

  test("preserves multiple upstream Set-Cookie fields only in response metadata", async () => {
    const headers = new Headers({ "X-Upstream": "yes" });
    headers.append("Set-Cookie", "first=1; Path=/; HttpOnly");
    headers.append("Set-Cookie", "second=2; Path=/; Secure");
    const response = await executeRelay(() =>
      Promise.resolve(new Response("ok", { headers })),
    );
    const metadata = readResponseMetadata(response);

    expect(
      metadata.headers.filter(({ name }) => name === "set-cookie"),
    ).toEqual([
      { name: "set-cookie", value: "first=1; Path=/; HttpOnly" },
      { name: "set-cookie", value: "second=2; Path=/; Secure" },
    ]);
    expect(response.headers.has("set-cookie")).toBe(false);
  });

  test("returns the exact upstream binary response body", async () => {
    const bytes = Uint8Array.from([0, 255, 1, 2, 3, 128]);
    const response = await executeRelay(() =>
      Promise.resolve(
        new Response(toArrayBuffer(bytes), {
          headers: { "Content-Length": String(bytes.byteLength) },
        }),
      ),
    );

    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(readResponseMetadata(response).declaredBodySizeBytes).toBe(
      bytes.byteLength,
    );
  });
});
