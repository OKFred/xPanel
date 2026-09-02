import {
  REMOTE_MAX_METADATA_BYTES,
  REMOTE_MAX_REQUEST_BODY_BYTES,
  REMOTE_MAX_RESPONSE_BODY_BYTES,
  REMOTE_PROTOCOL_VERSION,
  remoteCapabilitiesV1Schema,
  remoteRequestMetaV1Schema,
  type RemoteCapabilitiesV1,
} from "@xpanel/contracts";

import { readRequestBody } from "./body";
import { asRelayError, RelayError, relayErrorEnvelope } from "./errors";
import { executeTarget, streamRelayResponse, type Fetcher } from "./executor";
import {
  assertProtocol,
  decodeMetadata,
  encodeMetadata,
  REQUEST_METADATA_HEADER,
  RESPONSE_METADATA_HEADER,
} from "./protocol";
import { authenticateBearer, parseTargetPolicy } from "./security";

export interface Env {
  RELAY_TOKEN_SHA256: string;
  TARGET_POLICY: string;
  ALLOWED_TARGET_ORIGINS: string;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, X-XPanel-Protocol, X-XPanel-Request",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers":
    "Content-Length, X-XPanel-Protocol, X-XPanel-Response",
  "Access-Control-Max-Age": "600",
} as const;
const JSON_HEADERS = {
  ...CORS_HEADERS,
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
} as const;

function route(pathname: string): "capabilities" | "execute" | null {
  if (pathname.endsWith("/v1/capabilities")) return "capabilities";
  if (pathname.endsWith("/v1/execute")) return "execute";
  return null;
}

function jsonResponse(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: JSON_HEADERS,
  });
}

function capabilities(env: Env): RemoteCapabilitiesV1 {
  const policy = parseTargetPolicy(
    env.TARGET_POLICY,
    env.ALLOWED_TARGET_ORIGINS,
  );
  return remoteCapabilitiesV1Schema.parse({
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    provider: "cloudflare",
    targetPolicy: policy.kind,
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
}

async function requireAuthentication(
  request: Request,
  env: Env,
): Promise<void> {
  const authentication = await authenticateBearer(
    request.headers.get("Authorization"),
    env.RELAY_TOKEN_SHA256,
  );
  if (!authentication.configured) {
    throw new RelayError(
      500,
      "internal",
      "Relay authentication is not configured.",
    );
  }
  if (!authentication.authorized) {
    throw new RelayError(401, "unauthorized", "Invalid relay credentials.");
  }
}

async function execute(
  request: Request,
  env: Env,
  fetcher: Fetcher,
): Promise<Response> {
  const contentType = request.headers
    .get("Content-Type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/octet-stream") {
    throw new RelayError(
      415,
      "unsupported_request",
      "Relay execute requests must use application/octet-stream.",
    );
  }

  const decoded = decodeMetadata(request.headers.get(REQUEST_METADATA_HEADER));
  if (
    typeof decoded === "object" &&
    decoded !== null &&
    "bodySizeBytes" in decoded &&
    Number.isInteger(decoded.bodySizeBytes) &&
    Number(decoded.bodySizeBytes) > REMOTE_MAX_REQUEST_BODY_BYTES
  ) {
    const requestId =
      "requestId" in decoded && typeof decoded.requestId === "string"
        ? decoded.requestId
        : undefined;
    throw new RelayError(
      413,
      "payload_too_large",
      "The request body exceeds the relay limit.",
      requestId,
    );
  }
  const metadataResult = remoteRequestMetaV1Schema.safeParse(decoded);
  if (!metadataResult.success) {
    throw new RelayError(
      400,
      "invalid_metadata",
      "The request metadata does not match Relay V1.",
    );
  }
  const metadata = metadataResult.data;
  const requestStarted = performance.now();
  const body = await readRequestBody(
    request,
    metadata.bodySizeBytes,
    metadata.requestId,
    metadata.timeoutMs,
  );
  const remainingTimeoutMs = Math.max(
    1,
    Math.floor(metadata.timeoutMs - (performance.now() - requestStarted)),
  );
  const policy = parseTargetPolicy(
    env.TARGET_POLICY,
    env.ALLOWED_TARGET_ORIGINS,
  );
  const upstream = await executeTarget(
    { ...metadata, timeoutMs: remainingTimeoutMs },
    body,
    policy,
    new URL(request.url).origin,
    request.signal,
    fetcher,
  );
  let responseMetadata: string;
  try {
    responseMetadata = encodeMetadata(upstream.metadata);
  } catch (error) {
    upstream.abortScope.abort("cancelled");
    try {
      await upstream.response.body?.cancel("metadata_too_large");
    } catch {
      // Preserve the protocol error even if cancelling a broken upstream fails.
    } finally {
      upstream.abortScope.cleanup();
    }
    throw error;
  }
  const streamed = streamRelayResponse(upstream, metadata.requestId);
  const responseHeaders = new Headers({
    ...CORS_HEADERS,
    "Cache-Control": "no-store",
    "Content-Type": "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
    "X-XPanel-Protocol": String(REMOTE_PROTOCOL_VERSION),
    [RESPONSE_METADATA_HEADER]: responseMetadata,
  });
  if (streamed.metadata.declaredBodySizeBytes !== undefined) {
    responseHeaders.set(
      "Content-Length",
      String(streamed.metadata.declaredBodySizeBytes),
    );
  }
  return new Response(streamed.body, {
    status: 200,
    headers: responseHeaders,
  });
}

export async function handleRequest(
  request: Request,
  env: Env,
  fetcher: Fetcher = fetch,
): Promise<Response> {
  try {
    const selectedRoute = route(new URL(request.url).pathname);
    if (selectedRoute === null) {
      throw new RelayError(404, "unsupported_request", "Unknown Relay route.");
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (
      (selectedRoute === "capabilities" && request.method !== "GET") ||
      (selectedRoute === "execute" && request.method !== "POST")
    ) {
      throw new RelayError(
        405,
        "unsupported_request",
        "The HTTP method is not supported for this Relay route.",
      );
    }

    await requireAuthentication(request, env);
    assertProtocol(request);
    return selectedRoute === "capabilities"
      ? jsonResponse(capabilities(env), 200)
      : await execute(request, env, fetcher);
  } catch (error) {
    const relayError = asRelayError(error);
    return jsonResponse(relayErrorEnvelope(relayError), relayError.status);
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
