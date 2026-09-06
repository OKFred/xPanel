import {
  REMOTE_MAX_REQUEST_BODY_BYTES,
  REMOTE_MAX_RESPONSE_BODY_BYTES,
  REMOTE_PROTOCOL_VERSION,
  remoteRequestMetaV1Schema,
  remoteResponseMetaV1Schema,
  requestSpecV1Schema,
  type RequestSpecV1,
  type ResponseRecordV1,
} from "@xpanel/contracts";

import { boundFilesForRequest } from "../file-bindings";
import {
  invalidateRelayCapabilities,
  normalizeRelayBaseUrl,
  testRelayConnection,
} from "../remote-profiles";
import {
  beginExecution,
  finishExecution,
  normalizeExecutionError,
  reportProgress,
} from "./active";
import { requestUrl, resolveMaximumResponseBytes, warning } from "./common";
import { materializeResponse } from "./materialize";
import { materializeRemoteBody } from "./remote-body";
import { assertRemoteSupported } from "./remote-headers";
import {
  decodeMetadata,
  encodeMetadata,
  remoteFailure,
} from "./remote-protocol";
import { createManagedResponseStream } from "./response-stream";
import type {
  ExecuteOptionsV1,
  ExecuteTargetV1,
  ExecutionResponseStreamV1,
} from "./types";

function remoteExecuteUrl(
  profile: Extract<ExecuteTargetV1, { kind: "remote" }>["profile"],
): URL {
  return new URL(`${normalizeRelayBaseUrl(profile.baseUrl)}/v1/execute`);
}

export async function openRemoteResponse(
  requestInput: RequestSpecV1,
  target: Extract<ExecuteTargetV1, { kind: "remote" }>,
  options: ExecuteOptionsV1 = {},
): Promise<ExecutionResponseStreamV1> {
  const request = requestSpecV1Schema.parse(requestInput);
  assertRemoteSupported(request);
  boundFilesForRequest(request);
  if (target.token.trim() === "") {
    throw new Error("A Remote relay token is required.");
  }
  const requestedMaximumResponseBytes = resolveMaximumResponseBytes(
    options.maximumResponseBytes,
  );
  const execution = beginExecution(
    request.id,
    request.options.timeoutMs,
    options,
  );
  const { controller } = execution;
  const startedAt = new Date().toISOString();
  const start = performance.now();

  try {
    reportProgress(execution, "preparing", 0);
    reportProgress(execution, "requesting-permission", 0);
    const capabilities = await testRelayConnection(
      target.profile,
      target.token,
      {
        signal: controller.signal,
        permissionPreflighted: options.relayPermissionPreflighted === true,
        permissionAlreadyGranted:
          options.relayPermissionAlreadyGranted === true,
      },
    );
    if (controller.signal.aborted) {
      throw new DOMException("Request cancelled.", "AbortError");
    }
    const url = requestUrl(request);
    if (
      capabilities.targetPolicy === "public-https" &&
      url.protocol !== "https:"
    ) {
      throw new Error("This Remote relay only accepts public HTTPS targets.");
    }
    const body = await materializeRemoteBody(request);
    if (controller.signal.aborted) {
      throw new DOMException("Request cancelled.", "AbortError");
    }
    if (
      body.bodySizeBytes > capabilities.maxRequestBodyBytes ||
      body.bodySizeBytes > REMOTE_MAX_REQUEST_BODY_BYTES
    ) {
      throw new Error("Request body exceeds the 20 MiB Remote limit.");
    }
    const metadata = remoteRequestMetaV1Schema.parse({
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      requestId: request.id,
      method: request.method,
      url: url.toString(),
      headers: body.headers,
      redirect: request.options.redirect,
      timeoutMs: request.options.timeoutMs,
      bodySizeBytes: body.bodySizeBytes,
    });
    const encodedMetadata = encodeMetadata(metadata);
    if (
      new TextEncoder().encode(JSON.stringify(metadata)).byteLength >
      capabilities.maxMetadataBytes
    ) {
      throw new Error("Remote request metadata exceeds relay capabilities.");
    }

    reportProgress(
      execution,
      body.bodySizeBytes === 0 ? "waiting" : "uploading",
      0,
      body.bodySizeBytes === 0 ? undefined : body.bodySizeBytes,
    );
    const relayResponse = await fetch(remoteExecuteUrl(target.profile), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${target.token}`,
        "Content-Type": "application/octet-stream",
        "X-XPanel-Protocol": String(REMOTE_PROTOCOL_VERSION),
        "X-XPanel-Request": encodedMetadata,
      },
      ...(body.body === undefined ? {} : { body: body.body }),
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
    });
    if (relayResponse.status !== 200) {
      const failure = await remoteFailure(relayResponse);
      if (
        failure.code === "protocol_unsupported" ||
        failure.code === "invalid_metadata"
      ) {
        await invalidateRelayCapabilities(target.profile, target.token);
      }
      throw failure;
    }

    const encodedResponseMetadata =
      relayResponse.headers.get("X-XPanel-Response");
    if (!encodedResponseMetadata) {
      await invalidateRelayCapabilities(target.profile, target.token);
      throw new Error("Remote relay omitted response metadata.");
    }
    let responseMetadata;
    try {
      responseMetadata = remoteResponseMetaV1Schema.parse(
        decodeMetadata(encodedResponseMetadata),
      );
    } catch (error) {
      await invalidateRelayCapabilities(target.profile, target.token);
      throw error;
    }
    if (responseMetadata.requestId !== request.id) {
      await invalidateRelayCapabilities(target.profile, target.token);
      throw new Error("Remote relay returned a mismatched request ID.");
    }

    const maximumResponseBytes = Math.min(
      requestedMaximumResponseBytes,
      capabilities.maxResponseBodyBytes,
      REMOTE_MAX_RESPONSE_BODY_BYTES,
    );
    const responseHeaders = responseMetadata.headers.map((header) => ({
      ...header,
      enabled: true,
    }));
    const warnings = [...body.warnings, ...responseMetadata.warnings];
    if (
      responseMetadata.headers.some(
        (header) => header.name.toLowerCase() === "set-cookie",
      )
    ) {
      warnings.push(
        warning(
          "remote-cookies-not-applied",
          "Set-Cookie values are shown in the response but were not applied to Chrome cookies.",
          "headers",
        ),
      );
    }
    const timings = {
      startedAt,
      durationMs: performance.now() - start,
      requestMs: responseMetadata.upstreamDurationMs,
    };
    const managed = createManagedResponseStream({
      response: relayResponse,
      execution,
      maximumBytes: maximumResponseBytes,
      ...(responseMetadata.declaredBodySizeBytes === undefined
        ? {}
        : { declaredBytes: responseMetadata.declaredBodySizeBytes }),
      limitMessage: "Response body exceeds the 20 MiB Remote limit.",
      onFinalize: (loadedBytes, completed) => {
        timings.durationMs = performance.now() - start;
        if (
          completed &&
          responseMetadata.declaredBodySizeBytes !== undefined &&
          responseMetadata.declaredBodySizeBytes !== loadedBytes
        ) {
          warnings.push(
            warning(
              "remote-body-size-mismatch",
              `Relay declared ${responseMetadata.declaredBodySizeBytes} response bytes but sent ${loadedBytes}.`,
              "body",
            ),
          );
        }
      },
    });
    return {
      requestId: request.id,
      executor: "remote",
      status: responseMetadata.status,
      statusText: responseMetadata.statusText,
      headers: responseHeaders,
      timings,
      redirects: responseMetadata.redirects,
      warnings,
      stream: managed.stream,
      ...(managed.declaredLength === undefined
        ? {}
        : { declaredLength: managed.declaredLength }),
      maximumResponseBytes,
    };
  } catch (error) {
    finishExecution(execution);
    throw normalizeExecutionError(execution, error);
  }
}

export async function executeRemote(
  request: RequestSpecV1,
  target: Extract<ExecuteTargetV1, { kind: "remote" }>,
  options: ExecuteOptionsV1 = {},
): Promise<ResponseRecordV1> {
  return materializeResponse(
    await openRemoteResponse(request, target, options),
  );
}
