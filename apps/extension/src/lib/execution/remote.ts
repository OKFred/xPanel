import { OneFetchGatewayClient } from "@one-fetch/client";
import extensionPackage from "../../../package.json";
import {
  requestSpecV1Schema,
  type RequestSpecV1,
  type ResponseRecordV1,
  type OneFetchResponseDetailsV1,
} from "@xpanel/contracts";
import { boundFilesForRequest } from "../file-bindings";
import {
  assertSameConsent,
  controlFetch,
  testRelayConnection,
} from "../one-fetch-connection";
import {
  beginExecution,
  finishExecution,
  normalizeExecutionError,
  reportProgress,
} from "./active";
import { enabled, resolveMaximumResponseBytes, warning } from "./common";
import { materializeResponse } from "./materialize";
import { materializeRemoteBody } from "./remote-body";
import { assertRemoteSupported } from "./remote-headers";
import { createManagedResponseStream } from "./response-stream";
import {
  diagnosticResponse,
  finalizeRemoteReport,
  safeOuterHeaders,
} from "./one-fetch-report";
import type {
  ExecuteOptionsV1,
  ExecuteTargetV1,
  ExecutionResponseStreamV1,
} from "./types";

/** Adding editor query pairs must not re-encode the URL's existing query. */
export function oneFetchTargetUrl(request: RequestSpecV1): string {
  const url = new URL(request.url);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("HTTP targets only.");
  if (url.hash)
    throw new Error(
      "Target URL fragments are not sent over HTTP. Remove the fragment first.",
    );
  let value = url.href;
  const pairs = enabled(request.query).map(
    ({ name, value }) => [name, value] as const,
  );
  if (request.auth.kind === "api-key" && request.auth.location === "query")
    pairs.push([request.auth.name, request.auth.value]);
  for (const [name, content] of pairs)
    value += `${value.includes("?") ? "&" : "?"}${encodeURIComponent(name)}=${encodeURIComponent(content)}`;
  return value;
}

export async function openRemoteResponse(
  requestInput: RequestSpecV1,
  target: Extract<ExecuteTargetV1, { kind: "remote" }>,
  options: ExecuteOptionsV1 = {},
): Promise<ExecutionResponseStreamV1> {
  const request = requestSpecV1Schema.parse(requestInput);
  assertRemoteSupported(request);
  boundFilesForRequest(request);
  if (!target.token.trim()) throw new Error("An execution token is required.");
  const execution = beginExecution(
    request.id,
    request.options.timeoutMs,
    options,
  );
  const { signal } = execution.controller;
  const startedAt = new Date().toISOString();
  const start = performance.now();
  try {
    reportProgress(execution, "requesting-permission", 0);
    const capabilities = await testRelayConnection(
      target.profile,
      target.token,
      {
        signal,
        permissionPreflighted: options.relayPermissionPreflighted === true,
        permissionAlreadyGranted:
          options.relayPermissionAlreadyGranted === true,
      },
    );
    assertSameConsent(target.consent, capabilities);
    if (request.options.timeoutMs > capabilities.limits.timeoutMs)
      throw new Error("Request timeout exceeds service capabilities.");
    const body = await materializeRemoteBody(request);
    signal.throwIfAborted();
    if (body.bodySizeBytes > capabilities.limits.requestBodyBytes)
      throw new Error("Request body exceeds service limit.");
    const client = new OneFetchGatewayClient({
      gatewayUrl: target.profile.gatewayUrl,
      token: target.token,
      capabilities: capabilities.fetchOptions,
      client: { name: "xPanel", version: extensionPackage.version },
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          credentials: "omit",
          cache: "no-store",
          referrerPolicy: "no-referrer",
        }),
      executionReports: {
        controlUrl: target.profile.controlUrl,
        fetch: controlFetch,
      },
    });
    const result = await client.executeHttp({
      targetUrl: oneFetchTargetUrl(request),
      method: request.method,
      headers: body.headers,
      ...(body.body === undefined ? {} : { body: body.body }),
      bodySizeBytes: body.bodySizeBytes,
      fetchOptions: {
        redirect: request.options.redirect,
        timeoutMs: request.options.timeoutMs,
        ...(capabilities.provider === "supabase"
          ? { adapter: { supabaseAcceptMutations: true } }
          : capabilities.provider === "cloudflare"
            ? { adapter: { cloudflareAcceptMutations: true } }
            : {}),
      },
      userDenyRules: target.profile.userDenyRules,
      requestId: request.id,
      signal,
      onProgress: (progress) => {
        if (
          progress.phase === "preparing" ||
          progress.phase === "uploading" ||
          progress.phase === "waiting"
        ) {
          reportProgress(execution, progress.phase, 0, progress.totalBytes);
        }
      },
    });
    const { classification } = result;
    const signed =
      classification.source !== "intermediary"
        ? classification.metadata
        : undefined;
    const targetResponse =
      classification.source === "target" &&
      classification.target.kind === "http"
        ? classification.target
        : undefined;
    const details: OneFetchResponseDetailsV1 = {
      schemaVersion: 1,
      source:
        classification.source === "relay"
          ? "relay-error"
          : classification.source,
      outerStatus: result.response.status,
      outerHeaders: safeOuterHeaders(result.response.headers),
      mutations: signed?.mutations ?? [],
      audit: signed?.audit.state ?? "unknown",
      integrity: targetResponse ? "pending" : "unverified",
      ...(signed
        ? { configVersion: signed.configVersionUsed, timing: signed.timing }
        : {}),
      ...(signed?.reportId ? { reportId: signed.reportId } : {}),
      ...(classification.source === "intermediary"
        ? {
            reason:
              result.response.type === "opaqueredirect"
                ? "browser-opaque-redirect"
                : classification.reason,
          }
        : {}),
      ...(classification.source === "relay"
        ? { problem: classification.error }
        : {}),
    };
    const headers = targetResponse
      ? [
          ...targetResponse.headers.filter(
            (h) => h.name.toLowerCase() !== "set-cookie",
          ),
          ...targetResponse.setCookie.map((value) => ({
            name: "Set-Cookie",
            value,
          })),
        ]
      : details.outerHeaders;
    const warnings = [
      ...body.warnings,
      ...details.mutations.map((m) =>
        warning("vendor-header-mutation", `${m.name}: ${m.detail}`),
      ),
    ];
    if (targetResponse?.setCookie.length)
      warnings.push(
        warning(
          "remote-cookies-not-applied",
          "Set-Cookie is displayed only; Chrome cookies were not changed.",
        ),
      );
    if (!targetResponse)
      warnings.push(
        warning(
          "diagnostic-response",
          "Not a verified target response. Diagnostic capture is limited to 1 MiB.",
        ),
      );
    const maximumResponseBytes = targetResponse
      ? Math.min(
          resolveMaximumResponseBytes(options.maximumResponseBytes),
          capabilities.limits.responseBodyBytes,
          20 * 1024 * 1024,
        )
      : 1024 * 1024;
    const timings = { startedAt, durationMs: performance.now() - start };
    let loadedBytes = 0;
    const managed = createManagedResponseStream({
      response: targetResponse
        ? result.response
        : diagnosticResponse(result.response),
      execution,
      maximumBytes: maximumResponseBytes,
      deferCompletion: true,
      limitMessage: "Response body exceeds the configured service limit.",
      onFinalize: (loaded) => {
        loadedBytes = loaded;
        timings.durationMs = performance.now() - start;
      },
    });
    return {
      requestId: request.id,
      executor: "remote",
      status: targetResponse?.status ?? result.response.status,
      statusText: targetResponse?.statusText ?? result.response.statusText,
      headers: headers.map((h) => ({ ...h, enabled: true })),
      timings,
      redirects: [],
      warnings,
      stream: managed.stream,
      maximumResponseBytes,
      remoteDetails: details,
      ...(managed.declaredLength === undefined
        ? {}
        : { declaredLength: managed.declaredLength }),
      finalizeRemote: async () => {
        try {
          return await finalizeRemoteReport(
            details,
            target.profile,
            target.token,
            request.id,
            loadedBytes,
            signal,
          );
        } finally {
          finishExecution(execution);
        }
      },
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
