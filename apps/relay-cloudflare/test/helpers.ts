import {
  REMOTE_PROTOCOL_VERSION,
  remoteErrorEnvelopeV1Schema,
  remoteResponseMetaV1Schema,
  type RemoteErrorEnvelopeV1,
  type RemoteRequestMetaV1,
  type RemoteResponseMetaV1,
} from "@xpanel/contracts";

import type { Env } from "../src/index";
import { handleRequest } from "../src/index";
import type { Fetcher } from "../src/executor";
import {
  decodeMetadata,
  encodeMetadata,
  PROTOCOL_HEADER,
  REQUEST_METADATA_HEADER,
  RESPONSE_METADATA_HEADER,
} from "../src/protocol";

export const RELAY_TOKEN = "test-relay-token";
export const RELAY_TOKEN_SHA256 =
  "8ac5ac04b5072d24a84208c4672a3adac06fcdec6dbdf057552c2c2607029438";
export const RELAY_EXECUTE_URL = "https://relay.example.workers.dev/v1/execute";
export const RELAY_CAPABILITIES_URL =
  "https://relay.example.workers.dev/v1/capabilities";

export function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    RELAY_TOKEN_SHA256,
    TARGET_POLICY: "allowlist",
    ALLOWED_TARGET_ORIGINS: "https://api.example.com",
    ...overrides,
  };
}

export function createMetadata(
  overrides: Partial<RemoteRequestMetaV1> = {},
): RemoteRequestMetaV1 {
  return {
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    requestId: "request-1",
    method: "GET",
    url: "https://api.example.com/resource",
    headers: [],
    redirect: "follow",
    timeoutMs: 60_000,
    bodySizeBytes: 0,
    ...overrides,
  };
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function createExecuteRequest(
  metadata: RemoteRequestMetaV1 | Record<string, unknown>,
  body = new Uint8Array(),
  options: {
    authorization?: string | null;
    contentType?: string;
    protocol?: string;
    signal?: AbortSignal;
    metadataHeader?: string;
  } = {},
): Request {
  const headers = new Headers({
    "Content-Type": options.contentType ?? "application/octet-stream",
    [PROTOCOL_HEADER]: options.protocol ?? String(REMOTE_PROTOCOL_VERSION),
    [REQUEST_METADATA_HEADER]:
      options.metadataHeader ?? encodeMetadata(metadata),
  });
  if (options.authorization !== null) {
    headers.set(
      "Authorization",
      options.authorization ?? `Bearer ${RELAY_TOKEN}`,
    );
  }
  return new Request(RELAY_EXECUTE_URL, {
    method: "POST",
    headers,
    body: toArrayBuffer(body),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

export async function executeRelay(
  fetcher: Fetcher,
  metadata = createMetadata(),
  body = new Uint8Array(),
  env = createEnv(),
  options: Parameters<typeof createExecuteRequest>[2] = {},
): Promise<Response> {
  return handleRequest(
    createExecuteRequest(metadata, body, options),
    env,
    fetcher,
  );
}

export async function readRelayError(
  response: Response,
): Promise<RemoteErrorEnvelopeV1> {
  return remoteErrorEnvelopeV1Schema.parse(await response.json());
}

export function readResponseMetadata(response: Response): RemoteResponseMetaV1 {
  return remoteResponseMetaV1Schema.parse(
    decodeMetadata(response.headers.get(RESPONSE_METADATA_HEADER)),
  );
}
