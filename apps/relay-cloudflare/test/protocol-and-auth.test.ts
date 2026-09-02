import {
  REMOTE_MAX_METADATA_BYTES,
  REMOTE_MAX_REQUEST_BODY_BYTES,
  REMOTE_MAX_RESPONSE_BODY_BYTES,
  REMOTE_PROTOCOL_VERSION,
  remoteCapabilitiesV1Schema,
} from "@xpanel/contracts";
import { describe, expect, test, vi } from "vitest";

import { handleRequest } from "../src/index";
import type { Fetcher } from "../src/executor";
import { PROTOCOL_HEADER, REQUEST_METADATA_HEADER } from "../src/protocol";
import {
  createEnv,
  createExecuteRequest,
  createMetadata,
  readRelayError,
  RELAY_CAPABILITIES_URL,
  RELAY_TOKEN,
} from "./helpers";

const unusedFetcher: Fetcher = vi.fn(() =>
  Promise.reject(new Error("The upstream fetcher must not be called.")),
);

function capabilitiesRequest(
  overrides: {
    authorization?: string | null;
    protocol?: string | null;
    method?: string;
  } = {},
): Request {
  const headers = new Headers();
  if (overrides.authorization !== null) {
    headers.set(
      "Authorization",
      overrides.authorization ?? `Bearer ${RELAY_TOKEN}`,
    );
  }
  if (overrides.protocol !== null) {
    headers.set(
      PROTOCOL_HEADER,
      overrides.protocol ?? String(REMOTE_PROTOCOL_VERSION),
    );
  }
  return new Request(RELAY_CAPABILITIES_URL, {
    method: overrides.method ?? "GET",
    headers,
  });
}

describe("Relay V1 authentication and protocol envelope", () => {
  test("answers an unauthenticated browser preflight for known Relay routes", async () => {
    const response = await handleRequest(
      new Request(RELAY_CAPABILITIES_URL, {
        method: "OPTIONS",
        headers: {
          Origin: "chrome-extension://example",
          "Access-Control-Request-Headers": "authorization,x-xpanel-protocol",
          "Access-Control-Request-Method": "GET",
        },
      }),
      createEnv(),
      unusedFetcher,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toContain(
      "POST",
    );
    expect(response.headers.get("access-control-allow-headers")).toContain(
      "X-XPanel-Request",
    );
  });

  test.each([
    ["missing", null],
    ["malformed", "Basic abc"],
    ["incorrect", "Bearer not-the-token"],
  ])("rejects %s credentials without invoking the target", async (_, auth) => {
    const fetcher = vi.fn<Fetcher>();
    const response = await handleRequest(
      capabilitiesRequest({ authorization: auth }),
      createEnv(),
      fetcher,
    );

    expect(response.status).toBe(401);
    await expect(readRelayError(response)).resolves.toMatchObject({
      protocolVersion: 1,
      error: { code: "unauthorized", message: "Invalid relay credentials." },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("returns a generic internal error when the digest is not configured", async () => {
    const invalidDigest = "not-a-sha256";
    const response = await handleRequest(
      capabilitiesRequest(),
      createEnv({ RELAY_TOKEN_SHA256: invalidDigest }),
      unusedFetcher,
    );
    const payload = await readRelayError(response);

    expect(response.status).toBe(500);
    expect(payload.error).toEqual({
      code: "internal",
      message: "Relay authentication is not configured.",
    });
    expect(JSON.stringify(payload)).not.toContain(RELAY_TOKEN);
    expect(JSON.stringify(payload)).not.toContain(invalidDigest);
  });

  test.each([null, "0", "2", "01"])(
    "rejects unsupported outer protocol %s",
    async (protocol) => {
      const response = await handleRequest(
        capabilitiesRequest({ protocol }),
        createEnv(),
        unusedFetcher,
      );

      expect(response.status).toBe(400);
      await expect(readRelayError(response)).resolves.toMatchObject({
        error: { code: "protocol_unsupported" },
      });
    },
  );

  test("reports exact, schema-valid capabilities for an allowlist relay", async () => {
    const response = await handleRequest(
      capabilitiesRequest(),
      createEnv(),
      unusedFetcher,
    );
    const capabilities = remoteCapabilitiesV1Schema.parse(
      await response.json(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(capabilities).toEqual({
      protocolVersion: 1,
      provider: "cloudflare",
      targetPolicy: "allowlist",
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
    });
  });

  test("reports public-https only when the deployer explicitly configures it", async () => {
    const response = await handleRequest(
      capabilitiesRequest(),
      createEnv({ TARGET_POLICY: "public-https" }),
      unusedFetcher,
    );

    await expect(response.json()).resolves.toMatchObject({
      targetPolicy: "public-https",
    });
  });

  test.each([
    ["unknown route", "https://relay.example.workers.dev/v1/nope", "GET"],
    ["wrong capabilities method", RELAY_CAPABILITIES_URL, "POST"],
  ])("uses an error envelope for %s", async (_, url, method) => {
    const response = await handleRequest(
      new Request(url, {
        method,
        headers: {
          Authorization: `Bearer ${RELAY_TOKEN}`,
          [PROTOCOL_HEADER]: "1",
        },
      }),
      createEnv(),
      unusedFetcher,
    );

    expect(response.status).toBe(method === "POST" ? 405 : 404);
    await expect(readRelayError(response)).resolves.toMatchObject({
      protocolVersion: 1,
      error: { code: "unsupported_request" },
    });
  });

  test("rejects a non-octet-stream execute request", async () => {
    const request = createExecuteRequest(createMetadata(), new Uint8Array(), {
      contentType: "application/json",
    });
    const response = await handleRequest(request, createEnv(), unusedFetcher);

    expect(response.status).toBe(415);
    await expect(readRelayError(response)).resolves.toMatchObject({
      error: { code: "unsupported_request" },
    });
  });

  test.each([
    ["missing metadata", null],
    ["malformed base64url", "%%%"],
    ["invalid JSON", "bm90LWpzb24"],
  ])("rejects %s with invalid_metadata", async (_, metadataHeader) => {
    const request =
      metadataHeader === null
        ? createExecuteRequest(createMetadata())
        : createExecuteRequest(createMetadata(), new Uint8Array(), {
            metadataHeader,
          });
    if (metadataHeader === null)
      request.headers.delete(REQUEST_METADATA_HEADER);
    const response = await handleRequest(request, createEnv(), unusedFetcher);

    expect(response.status).toBe(400);
    await expect(readRelayError(response)).resolves.toMatchObject({
      error: { code: "invalid_metadata" },
    });
  });

  test.each([
    ["unknown metadata field", { ...createMetadata(), future: true }],
    ["unknown metadata version", { ...createMetadata(), protocolVersion: 2 }],
  ])("strictly rejects %s", async (_, metadata) => {
    const response = await handleRequest(
      createExecuteRequest(metadata),
      createEnv(),
      unusedFetcher,
    );

    expect(response.status).toBe(400);
    await expect(readRelayError(response)).resolves.toMatchObject({
      error: { code: "invalid_metadata" },
    });
  });

  test("maps an oversized declared body to payload_too_large", async () => {
    const response = await handleRequest(
      createExecuteRequest({
        ...createMetadata(),
        bodySizeBytes: REMOTE_MAX_REQUEST_BODY_BYTES + 1,
      }),
      createEnv(),
      unusedFetcher,
    );

    expect(response.status).toBe(413);
    await expect(readRelayError(response)).resolves.toMatchObject({
      requestId: "request-1",
      error: { code: "payload_too_large" },
    });
  });

  test("rejects encoded request metadata larger than 48 KiB before decoding", async () => {
    const oversizedHeader = "A".repeat(
      Math.ceil(REMOTE_MAX_METADATA_BYTES / 3) * 4 + 1,
    );
    const response = await handleRequest(
      createExecuteRequest(createMetadata(), new Uint8Array(), {
        metadataHeader: oversizedHeader,
      }),
      createEnv(),
      unusedFetcher,
    );

    expect(response.status).toBe(413);
    await expect(readRelayError(response)).resolves.toMatchObject({
      error: { code: "metadata_too_large" },
    });
  });

  test("does not expose unexpected exception details", async () => {
    const secret = "upstream-secret-that-must-not-leak";
    const fetcher: Fetcher = () => Promise.reject(new Error(secret));
    const response = await handleRequest(
      createExecuteRequest(createMetadata()),
      createEnv(),
      fetcher,
    );
    const body = await response.text();

    expect(response.status).toBe(502);
    expect(body).not.toContain(secret);
    expect(JSON.parse(body)).toMatchObject({
      error: {
        code: "upstream_network",
        message: "The relay could not connect to the target.",
      },
    });
  });
});
