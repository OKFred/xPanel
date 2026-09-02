import {
  REMOTE_MAX_RESPONSE_BODY_BYTES,
  REMOTE_PROTOCOL_VERSION,
  remoteResponseMetaV1Schema,
  type ExecutionWarning,
  type RedirectRecord,
  type RelayHeaderV1,
  type RemoteRequestMetaV1,
  type RemoteResponseMetaV1,
} from "@xpanel/contracts";
import { RelayError } from "./errors";
import {
  assertHeadersAllowed,
  assertTargetAllowed,
  dropBodyHeaders,
  stripCrossOriginHeaders,
  toFetchHeaders,
  type TargetPolicy,
} from "./security";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 20;
const METHODS_WITHOUT_BODY = new Set(["GET", "HEAD"]);
const UNSUPPORTED_METHODS = new Set(["CONNECT", "TRACE", "TRACK"]);

export type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface AbortScope {
  readonly signal: AbortSignal;
  readonly reason: () => "cancelled" | "timeout" | null;
  abort(reason: "cancelled" | "timeout"): void;
  cleanup(): void;
}

export interface RelayExecution {
  readonly response: Response;
  readonly metadata: RemoteResponseMetaV1;
  readonly abortScope: AbortScope;
}

export function createAbortScope(
  incomingSignal: AbortSignal,
  timeoutMs: number,
): AbortScope {
  const controller = new AbortController();
  let abortReason: "cancelled" | "timeout" | null = null;
  let cleaned = false;

  const abort = (reason: "cancelled" | "timeout"): void => {
    if (controller.signal.aborted) return;
    abortReason = reason;
    controller.abort(reason);
  };
  const onIncomingAbort = (): void => abort("cancelled");
  incomingSignal.addEventListener("abort", onIncomingAbort, { once: true });
  if (incomingSignal.aborted) abort("cancelled");
  const timeout = setTimeout(() => abort("timeout"), timeoutMs);

  return {
    signal: controller.signal,
    reason: () => abortReason,
    abort,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timeout);
      incomingSignal.removeEventListener("abort", onIncomingAbort);
    },
  };
}

function redirectDropsBody(status: number, method: string): boolean {
  return (
    status === 303 || ((status === 301 || status === 302) && method === "POST")
  );
}

function abortError(scope: AbortScope, requestId: string): RelayError {
  return scope.reason() === "timeout"
    ? new RelayError(
        504,
        "timeout",
        "The upstream request timed out.",
        requestId,
      )
    : new RelayError(
        499,
        "cancelled",
        "The upstream request was cancelled.",
        requestId,
      );
}

function responseHeaders(response: Response): RelayHeaderV1[] {
  const result: RelayHeaderV1[] = [];
  for (const [name, value] of response.headers.entries()) {
    if (name.toLowerCase() !== "set-cookie") result.push({ name, value });
  }
  for (const value of response.headers.getSetCookie()) {
    result.push({ name: "set-cookie", value });
  }
  return result;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer;
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function declaredResponseSize(response: Response): number | undefined {
  const value = response.headers.get("content-length");
  if (value === null || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

async function cancelResponseBody(
  response: Response,
  reason?: string,
): Promise<void> {
  try {
    await response.body?.cancel(reason);
  } catch {
    // Cancellation is cleanup and must not replace the protocol outcome.
  }
}

async function finalizeResponse(
  response: Response,
  requestId: string,
  redirects: readonly RedirectRecord[],
  warnings: readonly ExecutionWarning[],
  started: number,
  abortScope: AbortScope,
): Promise<RelayExecution> {
  const declaredBodySizeBytes =
    response.body === null ? 0 : declaredResponseSize(response);
  if (
    declaredBodySizeBytes !== undefined &&
    declaredBodySizeBytes > REMOTE_MAX_RESPONSE_BODY_BYTES
  ) {
    await cancelResponseBody(response, "response_too_large");
    abortScope.cleanup();
    throw new RelayError(
      502,
      "response_too_large",
      "The upstream response exceeds the relay limit.",
      requestId,
    );
  }

  try {
    const responseMetadata = remoteResponseMetaV1Schema.parse({
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      requestId,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders(response),
      redirects,
      upstreamDurationMs: performance.now() - started,
      ...(declaredBodySizeBytes === undefined ? {} : { declaredBodySizeBytes }),
      warnings,
    });
    return { response, metadata: responseMetadata, abortScope };
  } catch (error) {
    await cancelResponseBody(response, "invalid_response_metadata");
    abortScope.cleanup();
    throw error;
  }
}

export async function executeTarget(
  metadata: RemoteRequestMetaV1,
  body: Uint8Array,
  policy: TargetPolicy,
  relayOrigin: string,
  incomingSignal: AbortSignal,
  fetcher: Fetcher = fetch,
): Promise<RelayExecution> {
  if (UNSUPPORTED_METHODS.has(metadata.method)) {
    throw new RelayError(
      400,
      "unsupported_request",
      `The ${metadata.method} method is not supported by this relay.`,
      metadata.requestId,
    );
  }
  if (METHODS_WITHOUT_BODY.has(metadata.method) && body.byteLength > 0) {
    throw new RelayError(
      400,
      "unsupported_request",
      `${metadata.method} requests cannot include a body.`,
      metadata.requestId,
    );
  }
  assertHeadersAllowed(metadata.headers, metadata.requestId);

  const abortScope = createAbortScope(incomingSignal, metadata.timeoutMs);
  const started = performance.now();
  const redirects: RedirectRecord[] = [];
  const warnings: ExecutionWarning[] = [];
  let currentUrl = new URL(metadata.url);
  let currentMethod = metadata.method;
  let currentHeaders = [...metadata.headers];
  let currentBody: Uint8Array | undefined =
    body.byteLength === 0 ? undefined : body;

  try {
    for (;;) {
      assertTargetAllowed(currentUrl, policy, relayOrigin, metadata.requestId);
      if (abortScope.signal.aborted) {
        throw abortError(abortScope, metadata.requestId);
      }

      const hopStarted = performance.now();
      let response: Response;
      try {
        response = await fetcher(currentUrl, {
          method: currentMethod,
          headers: toFetchHeaders(currentHeaders),
          ...(currentBody === undefined
            ? {}
            : { body: asArrayBuffer(currentBody) }),
          cf: {
            cacheTtlByStatus: { "100-599": -1 },
          },
          redirect: "manual",
          signal: abortScope.signal,
        });
      } catch {
        if (abortScope.signal.aborted) {
          throw abortError(abortScope, metadata.requestId);
        }
        throw new RelayError(
          502,
          "upstream_network",
          "The relay could not connect to the target.",
          metadata.requestId,
        );
      }

      if (!REDIRECT_STATUSES.has(response.status)) {
        return await finalizeResponse(
          response,
          metadata.requestId,
          redirects,
          warnings,
          started,
          abortScope,
        );
      }

      if (metadata.redirect === "manual") {
        return await finalizeResponse(
          response,
          metadata.requestId,
          redirects,
          warnings,
          started,
          abortScope,
        );
      }

      const location = response.headers.get("location");
      if (metadata.redirect === "error") {
        await cancelResponseBody(response, "redirect_disallowed");
        throw new RelayError(
          400,
          "redirect_disallowed",
          "The target returned a redirect while redirect handling is set to error.",
          metadata.requestId,
        );
      }
      if (location === null) {
        return await finalizeResponse(
          response,
          metadata.requestId,
          redirects,
          warnings,
          started,
          abortScope,
        );
      }
      if (redirects.length >= MAX_REDIRECTS) {
        await cancelResponseBody(response, "redirect_limit");
        throw new RelayError(
          400,
          "redirect_disallowed",
          `The target exceeded ${MAX_REDIRECTS} redirects.`,
          metadata.requestId,
        );
      }

      let nextUrl: URL;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch {
        await cancelResponseBody(response, "invalid_redirect_url");
        throw new RelayError(
          400,
          "redirect_disallowed",
          "The target returned an invalid redirect URL.",
          metadata.requestId,
        );
      }
      try {
        assertTargetAllowed(nextUrl, policy, relayOrigin, metadata.requestId);
      } catch (error) {
        await cancelResponseBody(response, "redirect_target_not_allowed");
        throw error;
      }

      const dropsBody = redirectDropsBody(response.status, currentMethod);
      if (
        nextUrl.origin !== currentUrl.origin &&
        currentBody !== undefined &&
        !dropsBody
      ) {
        warnings.push({
          code: "remote.redirect_body_replay_requires_confirmation",
          message:
            "The relay returned this redirect without replaying the request body across origins. Review the Location header and send the destination explicitly.",
          path: "options.redirect",
        });
        return await finalizeResponse(
          response,
          metadata.requestId,
          redirects,
          warnings,
          started,
          abortScope,
        );
      }

      if (nextUrl.origin !== currentUrl.origin) {
        const stripped = stripCrossOriginHeaders(currentHeaders);
        currentHeaders = stripped.headers;
        if (stripped.strippedNames.length > 0) {
          warnings.push({
            code: "remote.redirect_headers_stripped",
            message: `Removed request headers on a cross-origin redirect: ${stripped.strippedNames.join(", ")}.`,
            path: "headers",
          });
        }
      }

      redirects.push({
        url: nextUrl.toString(),
        status: response.status,
        method: currentMethod,
        durationMs: performance.now() - hopStarted,
      });
      await cancelResponseBody(response, "redirect_followed");

      if (dropsBody) {
        currentMethod = currentMethod === "HEAD" ? "HEAD" : "GET";
        currentBody = undefined;
        currentHeaders = dropBodyHeaders(currentHeaders);
      }
      currentUrl = nextUrl;
    }
  } catch (error) {
    abortScope.cleanup();
    throw error;
  }
}

export function streamRelayResponse(
  execution: RelayExecution,
  requestId: string,
): { body: ReadableStream<Uint8Array> | null; metadata: RemoteResponseMetaV1 } {
  const source = execution.response.body;
  if (source === null) {
    execution.abortScope.cleanup();
    return {
      body: null,
      metadata: remoteResponseMetaV1Schema.parse({
        ...execution.metadata,
        declaredBodySizeBytes: 0,
      }),
    };
  }

  const reader = source.getReader();
  let transferred = 0;
  let overflowPending = false;
  let finished = false;

  const finish = (): void => {
    if (finished) return;
    finished = true;
    reader.releaseLock();
    execution.abortScope.cleanup();
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (overflowPending) {
        finish();
        controller.error(new Error("response_too_large"));
        return;
      }
      if (execution.abortScope.signal.aborted) {
        finish();
        controller.error(abortError(execution.abortScope, requestId));
        return;
      }
      try {
        const result = await reader.read();
        if (result.done) {
          finish();
          controller.close();
          return;
        }
        const remaining = REMOTE_MAX_RESPONSE_BODY_BYTES - transferred;
        if (result.value.byteLength > remaining) {
          if (remaining > 0) {
            controller.enqueue(result.value.subarray(0, remaining));
            transferred += remaining;
            overflowPending = true;
            await reader.cancel("response_too_large");
            return;
          }
          await reader.cancel("response_too_large");
          finish();
          controller.error(new Error("response_too_large"));
          return;
        }
        transferred += result.value.byteLength;
        controller.enqueue(result.value);
      } catch (error) {
        finish();
        controller.error(
          execution.abortScope.signal.aborted
            ? abortError(execution.abortScope, requestId)
            : error,
        );
      }
    },
    async cancel(reason) {
      execution.abortScope.abort("cancelled");
      try {
        await reader.cancel(reason);
      } finally {
        finish();
      }
    },
  });

  return {
    body,
    metadata: execution.metadata,
  };
}
