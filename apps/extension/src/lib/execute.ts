import {
  REMOTE_MAX_METADATA_BYTES,
  REMOTE_MAX_REQUEST_BODY_BYTES,
  REMOTE_MAX_RESPONSE_BODY_BYTES,
  REMOTE_PROTOCOL_VERSION,
  executionProgressV1Schema,
  relayHeaderV1Schema,
  remoteErrorEnvelopeV1Schema,
  remoteRequestMetaV1Schema,
  remoteResponseMetaV1Schema,
  requestSpecV1Schema,
  responseRecordV1Schema,
  type ExecutionWarning,
  type ExecutionProgressV1,
  type KeyValueItem,
  type RelayHeaderV1,
  type RemoteRelayProfileV1,
  type RequestSpecV1,
  type ResponseRecordV1,
} from "@xpanel/contracts";

import { boundFile, boundFilesForRequest } from "./file-bindings";
import {
  invalidateRelayCapabilities,
  normalizeRelayBaseUrl,
  testRelayConnection,
} from "./remote-profiles";

const forbiddenBrowserHeaders = new Set([
  "accept-charset",
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "connection",
  "content-length",
  "cookie",
  "cookie2",
  "date",
  "dnt",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "proxy-authorization",
  "referer",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
]);

const conditionalForbiddenBrowserHeaders = new Set([
  "x-http-method",
  "x-http-method-override",
  "x-method-override",
]);

const forbiddenBrowserMethods = new Set(["CONNECT", "TRACE", "TRACK"]);

interface ActiveExecution {
  controller: AbortController;
  onProgress?: (progress: ExecutionProgressV1) => void;
  startedAt: number;
  cancelling: boolean;
  lastProgress?: ExecutionProgressV1;
}

const activeRequests = new Map<string, ActiveExecution>();

export type ExecuteTargetV1 =
  | { kind: "browser" }
  | {
      kind: "remote";
      profile: RemoteRelayProfileV1;
      token: string;
    };

export interface ExecuteOptionsV1 {
  target?: ExecuteTargetV1;
  onProgress?: (progress: ExecutionProgressV1) => void;
  relayPermissionAlreadyGranted?: boolean;
}

function beginExecution(
  requestId: string,
  options: ExecuteOptionsV1,
): ActiveExecution {
  if (activeRequests.has(requestId)) {
    throw new Error("This request is already running.");
  }
  const execution: ActiveExecution = {
    controller: new AbortController(),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    startedAt: performance.now(),
    cancelling: false,
  };
  activeRequests.set(requestId, execution);
  return execution;
}

function reportProgress(
  execution: ActiveExecution,
  phase: ExecutionProgressV1["phase"],
  loadedBytes: number,
  totalBytes?: number,
): void {
  const progress = executionProgressV1Schema.parse({
    phase,
    loadedBytes,
    ...(totalBytes === undefined ? {} : { totalBytes }),
    elapsedMs: performance.now() - execution.startedAt,
  });
  execution.lastProgress = progress;
  try {
    execution.onProgress?.(progress);
  } catch {
    // Progress observers cannot fail request execution.
  }
}

function enabled(items: KeyValueItem[]): KeyValueItem[] {
  return items.filter((item) => item.enabled && item.name.trim() !== "");
}

function warning(
  code: string,
  message: string,
  path?: string,
): ExecutionWarning {
  return { code, message, ...(path ? { path } : {}) };
}

function isForbiddenBrowserHeader(name: string, value = ""): boolean {
  const normalized = name.trim().toLowerCase();
  return (
    forbiddenBrowserHeaders.has(normalized) ||
    normalized.startsWith("proxy-") ||
    normalized.startsWith("sec-") ||
    (conditionalForbiddenBrowserHeaders.has(normalized) &&
      value
        .split(",")
        .map((method) => method.trim().toUpperCase())
        .some((method) => forbiddenBrowserMethods.has(method)))
  );
}

export interface RemovedBrowserHeader {
  /** The first spelling encountered, trimmed for display. */
  name: string;
  /** Number of enabled headers removed with this case-insensitive name. */
  occurrences: number;
}

export interface BrowserHeaderSanitizationResult {
  request: RequestSpecV1;
  removedHeaders: RemovedBrowserHeader[];
}

/**
 * Create a plain request that Browser Fetch can send after dropping regular
 * forbidden headers. Disabled headers and non-header unsupported features are
 * retained so callers can still edit them or report those limitations.
 */
export function sanitizeBrowserRequestHeaders(
  request: RequestSpecV1,
): BrowserHeaderSanitizationResult {
  const sanitized = requestSpecV1Schema.parse(request);
  const removedHeaders: RemovedBrowserHeader[] = [];
  const removedByName = new Map<string, RemovedBrowserHeader>();

  sanitized.headers = sanitized.headers.filter((header) => {
    if (
      !header.enabled ||
      !isForbiddenBrowserHeader(header.name, header.value)
    ) {
      return true;
    }

    const displayName = header.name.trim();
    const normalizedName = displayName.toLowerCase();
    const existing = removedByName.get(normalizedName);
    if (existing) {
      existing.occurrences += 1;
    } else {
      const removed = { name: displayName, occurrences: 1 };
      removedByName.set(normalizedName, removed);
      removedHeaders.push(removed);
    }
    return false;
  });

  return { request: sanitized, removedHeaders };
}

/**
 * Return every request feature that Fetch cannot reproduce faithfully.
 *
 * Importers intentionally retain these fields so command/HAR/OpenAPI round trips
 * remain lossless. Sending never drops them silently.
 */
export function browserUnsupportedReasons(request: RequestSpecV1): string[] {
  const reasons: string[] = [];
  if (["CONNECT", "TRACE", "TRACK"].includes(request.method)) {
    reasons.push(`${request.method} is not supported by browser Fetch`);
  }
  if (request.options.proxy !== null) {
    reasons.push("an explicit proxy");
  }
  if (!request.options.tls.verify) {
    reasons.push("disabled TLS certificate verification");
  }
  if (request.options.tls.caFile) {
    reasons.push("a custom CA certificate");
  }
  if (request.options.tls.clientCertificate) {
    reasons.push("a client certificate");
  }
  if (request.auth.kind === "api-key") {
    if (request.auth.location === "cookie") {
      reasons.push("an explicit Cookie value");
    }
    if (
      request.auth.location === "header" &&
      isForbiddenBrowserHeader(request.auth.name, request.auth.value)
    ) {
      reasons.push(`the forbidden ${request.auth.name} header`);
    }
  }
  for (const header of enabled(request.headers)) {
    if (isForbiddenBrowserHeader(header.name, header.value)) {
      reasons.push(`the forbidden ${header.name} header`);
    }
  }
  if (
    request.body.kind === "multipart" &&
    request.body.parts.some(
      (part) => part.enabled && enabled(part.headers ?? []).length > 0,
    )
  ) {
    reasons.push("custom multipart part headers");
  }
  return [...new Set(reasons)];
}

function assertBrowserSupported(request: RequestSpecV1): void {
  const reasons = browserUnsupportedReasons(request);
  if (reasons.length === 0) return;
  throw new Error(
    `Browser Fetch cannot preserve this request because it uses ${reasons.join(
      ", ",
    )}. Remove those options before sending.`,
  );
}

function requestUrl(request: RequestSpecV1): URL {
  const url = new URL(request.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Browser requests must use an HTTP or HTTPS URL.");
  }
  for (const item of enabled(request.query)) {
    url.searchParams.append(item.name, item.value);
  }
  if (request.auth.kind === "api-key" && request.auth.location === "query") {
    url.searchParams.set(request.auth.name, request.auth.value);
  }
  return url;
}

function bytesToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function requestHeaders(request: RequestSpecV1): Headers {
  const headers = new Headers();
  for (const item of enabled(request.headers)) {
    headers.append(item.name, item.value);
  }
  switch (request.auth.kind) {
    case "basic":
      headers.set(
        "Authorization",
        `Basic ${bytesToBase64(
          new TextEncoder().encode(
            `${request.auth.username}:${request.auth.password}`,
          ),
        )}`,
      );
      break;
    case "bearer":
      headers.set("Authorization", `Bearer ${request.auth.token}`);
      break;
    case "oauth2":
      headers.set(
        "Authorization",
        `${request.auth.tokenType} ${request.auth.accessToken}`,
      );
      break;
    case "api-key":
      if (request.auth.location === "header") {
        headers.set(request.auth.name, request.auth.value);
      }
      break;
    case "none":
      break;
  }
  return headers;
}

function requestBody(
  request: RequestSpecV1,
  headers: Headers,
): { body?: BodyInit; warnings: ExecutionWarning[] } {
  const warnings: ExecutionWarning[] = [];
  if (
    request.method === "GET" ||
    request.method === "HEAD" ||
    request.body.kind === "none"
  ) {
    if (
      request.body.kind !== "none" &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      warnings.push(
        warning(
          "browser-method-body",
          `${request.method} requests cannot carry a Fetch body.`,
          "body",
        ),
      );
    }
    return { warnings };
  }

  switch (request.body.kind) {
    case "json":
      if (!headers.has("Content-Type")) {
        headers.set(
          "Content-Type",
          request.body.mediaType ?? "application/json",
        );
      }
      return { body: request.body.text, warnings };
    case "text":
      if (request.body.mediaType && !headers.has("Content-Type")) {
        headers.set("Content-Type", request.body.mediaType);
      }
      return { body: request.body.text, warnings };
    case "urlencoded": {
      const body = new URLSearchParams();
      for (const item of enabled(request.body.entries)) {
        body.append(item.name, item.value);
      }
      if (!headers.has("Content-Type")) {
        headers.set(
          "Content-Type",
          "application/x-www-form-urlencoded;charset=UTF-8",
        );
      }
      return { body, warnings };
    }
    case "multipart": {
      const body = new FormData();
      if (headers.has("Content-Type")) {
        warnings.push(
          warning(
            "browser-multipart-content-type",
            "Browser Fetch generated the multipart Content-Type boundary.",
            "headers.Content-Type",
          ),
        );
      }
      for (const part of request.body.parts) {
        if (!part.enabled) continue;
        if (part.kind === "text") {
          body.append(part.name, part.value);
        } else {
          const file = boundFile(part.file);
          body.append(part.name, file, file.name);
        }
      }
      // Fetch must generate the multipart boundary.
      headers.delete("Content-Type");
      return { body, warnings };
    }
    case "file": {
      const file = boundFile(request.body.file);
      if (!headers.has("Content-Type")) {
        const mediaType =
          request.body.mediaType ?? request.body.file.mediaType ?? file.type;
        if (mediaType) headers.set("Content-Type", mediaType);
      }
      return { body: file, warnings };
    }
  }
}

function browserBodySize(body: BodyInit | undefined): number | undefined {
  if (body === undefined) return 0;
  if (typeof body === "string")
    return new TextEncoder().encode(body).byteLength;
  if (body instanceof URLSearchParams) {
    return new TextEncoder().encode(body.toString()).byteLength;
  }
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return undefined;
}

function isTextMediaType(mediaType: string): boolean {
  return (
    mediaType.startsWith("text/") ||
    mediaType.includes("json") ||
    mediaType.includes("xml") ||
    mediaType.includes("javascript") ||
    mediaType.includes("yaml")
  );
}

async function ensureOriginPermission(url: URL): Promise<void> {
  const originPattern = `${url.protocol}//${url.host}/*`;
  // This must be the first asynchronous Chrome call in the click chain.
  // Calling contains() first can consume the user activation required by
  // permissions.request() inside a DevTools panel.
  const granted = await chrome.permissions.request({
    origins: [originPattern],
  });
  if (!granted) {
    throw new Error(`Host permission was not granted for ${url.origin}.`);
  }
}

function responseContentLength(response: Response): number | undefined {
  const value = response.headers.get("content-length");
  if (value === null || !/^\d+$/u.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

async function readResponseBytes(
  response: Response,
  execution: ActiveExecution,
  maximumBytes?: number,
  declaredBytes?: number,
): Promise<Uint8Array> {
  const headerBytes = responseContentLength(response);
  if (
    maximumBytes !== undefined &&
    headerBytes !== undefined &&
    headerBytes > maximumBytes
  ) {
    throw new Error("Response body exceeds the 20 MiB Remote limit.");
  }
  const totalBytes = declaredBytes ?? headerBytes;
  if (
    maximumBytes !== undefined &&
    totalBytes !== undefined &&
    totalBytes > maximumBytes
  ) {
    throw new Error("Response body exceeds the 20 MiB Remote limit.");
  }
  reportProgress(execution, "downloading", 0, totalBytes);
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (maximumBytes !== undefined && bytes.byteLength > maximumBytes) {
      throw new Error("Response body exceeds the 20 MiB Remote limit.");
    }
    reportProgress(execution, "downloading", bytes.byteLength, totalBytes);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loadedBytes = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      loadedBytes += result.value.byteLength;
      if (maximumBytes !== undefined && loadedBytes > maximumBytes) {
        await reader.cancel("response-too-large");
        throw new Error("Response body exceeds the 20 MiB Remote limit.");
      }
      chunks.push(result.value);
      reportProgress(execution, "downloading", loadedBytes, totalBytes);
    }
  } catch (error) {
    if (maximumBytes !== undefined && loadedBytes >= maximumBytes) {
      throw new Error("Response body exceeds the 20 MiB Remote limit.", {
        cause: error,
      });
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(loadedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function executeBrowser(
  request: RequestSpecV1,
  options: ExecuteOptionsV1 = {},
): Promise<ResponseRecordV1> {
  assertBrowserSupported(request);
  // Validate session-only file bindings before requesting site access.
  boundFilesForRequest(request);
  const url = requestUrl(request);
  const execution = beginExecution(request.id, options);
  const { controller } = execution;
  reportProgress(execution, "preparing", 0);
  const timeout = window.setTimeout(
    () => controller.abort("timeout"),
    request.options.timeoutMs,
  );

  try {
    reportProgress(execution, "requesting-permission", 0);
    await ensureOriginPermission(url);
    if (controller.signal.aborted) {
      throw new DOMException("Request cancelled.", "AbortError");
    }
    const startedAt = new Date().toISOString();
    const start = performance.now();
    const headers = requestHeaders(request);
    const bodyResult = requestBody(request, headers);
    const redirects: ResponseRecordV1["redirects"] = [];
    let nextRequestUrl = url;
    let method = request.method;
    let body = bodyResult.body;
    let nextHeaders = headers;
    let credentials: RequestCredentials = request.options.cookieMode;
    let response: Response;

    const uploadBytes = browserBodySize(body);
    reportProgress(execution, "uploading", 0, uploadBytes);
    reportProgress(execution, "waiting", 0, uploadBytes);
    for (;;) {
      response = await fetch(nextRequestUrl, {
        method,
        headers: nextHeaders,
        ...(body === undefined ? {} : { body }),
        credentials,
        redirect:
          request.options.redirect === "follow"
            ? "manual"
            : request.options.redirect,
        signal: controller.signal,
        cache: "no-store",
      });
      if (
        request.options.redirect !== "follow" ||
        ![301, 302, 303, 307, 308].includes(response.status)
      ) {
        break;
      }
      if (response.type === "opaqueredirect" || response.status === 0) {
        throw new Error(
          "Browser Fetch cannot inspect this cross-origin redirect. Send the redirected URL explicitly.",
        );
      }
      const location = response.headers.get("location");
      if (!location) break;
      if (redirects.length >= 20) {
        throw new Error("The request exceeded 20 redirects.");
      }

      const redirectUrl = new URL(location, nextRequestUrl);
      const redirectedHeaders = new Headers(nextHeaders);
      const dropsBody =
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) &&
          method === "POST");

      if (redirectUrl.origin !== nextRequestUrl.origin) {
        if (body !== undefined && !dropsBody) {
          throw new Error(
            "A cross-origin redirect attempted to replay the request body. Send the redirected URL explicitly after reviewing it.",
          );
        }
        for (const name of [...redirectedHeaders.keys()]) {
          redirectedHeaders.delete(name);
        }
        credentials = "omit";
        const hasPermission = await chrome.permissions.contains({
          origins: [`${redirectUrl.origin}/*`],
        });
        if (!hasPermission) {
          throw new Error(
            `The request redirected to ${redirectUrl.origin}. Review that origin and send it explicitly to grant access.`,
          );
        }
      }

      redirects.push({
        url: redirectUrl.toString(),
        status: response.status,
        method,
      });
      if (dropsBody) {
        method = method === "HEAD" ? "HEAD" : "GET";
        body = undefined;
        redirectedHeaders.delete("content-type");
        redirectedHeaders.delete("content-length");
      }
      nextRequestUrl = redirectUrl;
      nextHeaders = redirectedHeaders;
    }

    const bytes = await readResponseBytes(response, execution);
    if (controller.signal.aborted) {
      throw new DOMException("Request cancelled.", "AbortError");
    }
    const mediaType =
      response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    const textBody = isTextMediaType(mediaType);
    const content = textBody
      ? new TextDecoder().decode(bytes)
      : bytesToBase64(bytes);

    const result = responseRecordV1Schema.parse({
      requestId: request.id,
      executor: "browser",
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers.entries()].map(([name, value]) => ({
        name,
        value,
        enabled: true,
      })),
      body: {
        kind: "inline",
        encoding: textBody ? "utf8" : "base64",
        content,
        ...(mediaType ? { mediaType } : {}),
        sizeBytes: bytes.byteLength,
      },
      timings: {
        startedAt,
        durationMs: performance.now() - start,
      },
      redirects,
      warnings: bodyResult.warnings,
    });
    reportProgress(execution, "complete", bytes.byteLength, bytes.byteLength);
    return result;
  } catch (error) {
    if (controller.signal.aborted) {
      const reason =
        controller.signal.reason === "timeout"
          ? "Request timed out."
          : "Request cancelled.";
      throw new DOMException(reason, "AbortError");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
    activeRequests.delete(request.id);
  }
}

const forbiddenRemoteHeaders = new Set([
  "connection",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function isForbiddenRemoteHeader(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return (
    forbiddenRemoteHeaders.has(normalized) || normalized.startsWith("proxy-")
  );
}

export function remoteUnsupportedReasons(request: RequestSpecV1): string[] {
  const reasons: string[] = [];
  if (forbiddenBrowserMethods.has(request.method)) {
    reasons.push(`${request.method} is not supported by the Remote relay`);
  }
  if (request.options.proxy !== null) reasons.push("an explicit proxy");
  if (!request.options.tls.verify) {
    reasons.push("disabled TLS certificate verification");
  }
  if (request.options.tls.caFile) reasons.push("a custom CA certificate");
  if (request.options.tls.clientCertificate) {
    reasons.push("a client certificate");
  }
  if (
    request.auth.kind === "api-key" &&
    request.auth.location === "header" &&
    isForbiddenRemoteHeader(request.auth.name)
  ) {
    reasons.push(`the unsupported ${request.auth.name} header`);
  }
  for (const header of enabled(request.headers)) {
    if (isForbiddenRemoteHeader(header.name)) {
      reasons.push(`the unsupported ${header.name} header`);
    }
  }
  return [...new Set(reasons)];
}

function assertRemoteSupported(request: RequestSpecV1): void {
  const reasons = remoteUnsupportedReasons(request);
  if (reasons.length === 0) return;
  throw new Error(
    `Remote relay cannot preserve this request because it uses ${reasons.join(
      ", ",
    )}. Remove those options before sending.`,
  );
}

function setRelayHeader(
  headers: RelayHeaderV1[],
  name: string,
  value: string,
): void {
  const normalized = name.trim().toLowerCase();
  for (let index = headers.length - 1; index >= 0; index -= 1) {
    if (headers[index]?.name.toLowerCase() === normalized) {
      headers.splice(index, 1);
    }
  }
  headers.push(relayHeaderV1Schema.parse({ name: name.trim(), value }));
}

function relayHeaderValue(
  headers: readonly RelayHeaderV1[],
  name: string,
): string | undefined {
  const normalized = name.toLowerCase();
  return headers.find((header) => header.name.toLowerCase() === normalized)
    ?.value;
}

function remoteTargetHeaders(request: RequestSpecV1): RelayHeaderV1[] {
  const headers = enabled(request.headers).map((header) =>
    relayHeaderV1Schema.parse({
      name: header.name.trim(),
      value: header.value,
    }),
  );
  switch (request.auth.kind) {
    case "basic":
      setRelayHeader(
        headers,
        "Authorization",
        `Basic ${bytesToBase64(
          new TextEncoder().encode(
            `${request.auth.username}:${request.auth.password}`,
          ),
        )}`,
      );
      break;
    case "bearer":
      setRelayHeader(headers, "Authorization", `Bearer ${request.auth.token}`);
      break;
    case "oauth2":
      setRelayHeader(
        headers,
        "Authorization",
        `${request.auth.tokenType} ${request.auth.accessToken}`,
      );
      break;
    case "api-key":
      if (request.auth.location === "header") {
        setRelayHeader(headers, request.auth.name, request.auth.value);
      } else if (request.auth.location === "cookie") {
        const existing = relayHeaderValue(headers, "Cookie");
        setRelayHeader(
          headers,
          "Cookie",
          `${existing ? `${existing}; ` : ""}${request.auth.name}=${request.auth.value}`,
        );
      }
      break;
    case "none":
      break;
  }
  return headers;
}

interface MaterializedRemoteBody {
  body: BodyInit | undefined;
  bodySizeBytes: number;
  headers: RelayHeaderV1[];
  warnings: ExecutionWarning[];
}

function assertRemoteBodySize(size: number): void {
  if (size > REMOTE_MAX_REQUEST_BODY_BYTES) {
    throw new Error("Request body exceeds the 20 MiB Remote limit.");
  }
}

function safeDispositionValue(value: string): string {
  return value.replace(/["\r\n]/gu, (character) =>
    character === '"' ? "%22" : "",
  );
}

function partHeaders(
  name: string,
  customHeaders: readonly KeyValueItem[],
  file?: File,
): RelayHeaderV1[] {
  const headers = enabled([...customHeaders]).map((header) =>
    relayHeaderV1Schema.parse({
      name: header.name.trim(),
      value: header.value,
    }),
  );
  if (relayHeaderValue(headers, "Content-Disposition") === undefined) {
    const filename = file
      ? `; filename="${safeDispositionValue(file.name)}"`
      : "";
    headers.unshift({
      name: "Content-Disposition",
      value: `form-data; name="${safeDispositionValue(name)}"${filename}`,
    });
  }
  if (file?.type && relayHeaderValue(headers, "Content-Type") === undefined) {
    headers.push({ name: "Content-Type", value: file.type });
  }
  return headers;
}

async function deterministicMultipartBoundary(
  requestId: string,
): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(requestId)),
  );
  const suffix = [...digest]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `----xpanel-${suffix}`;
}

async function materializeMultipartBody(
  request: RequestSpecV1,
  headers: RelayHeaderV1[],
): Promise<MaterializedRemoteBody> {
  if (request.body.kind !== "multipart") {
    throw new Error("Expected a multipart request body.");
  }
  const encoder = new TextEncoder();
  const boundary = await deterministicMultipartBoundary(request.id);
  const chunks: BlobPart[] = [];
  let accumulatedSize = 0;
  const appendText = (chunk: string): void => {
    accumulatedSize += encoder.encode(chunk).byteLength;
    assertRemoteBodySize(accumulatedSize);
    chunks.push(chunk);
  };

  for (const part of request.body.parts) {
    if (!part.enabled) continue;
    const file = part.kind === "file" ? boundFile(part.file) : undefined;
    if (file) assertRemoteBodySize(accumulatedSize + file.size);
    const headersForPart = partHeaders(part.name, part.headers ?? [], file);
    appendText(`--${boundary}\r\n`);
    for (const header of headersForPart) {
      appendText(`${header.name}: ${header.value}\r\n`);
    }
    appendText("\r\n");
    if (part.kind === "file") {
      if (!file) throw new Error("The selected multipart file is unavailable.");
      chunks.push(file);
      accumulatedSize += file.size;
      assertRemoteBodySize(accumulatedSize);
    } else {
      appendText(part.value);
    }
    appendText("\r\n");
  }
  appendText(`--${boundary}--\r\n`);
  setRelayHeader(
    headers,
    "Content-Type",
    `multipart/form-data; boundary=${boundary}`,
  );
  const body = new Blob(chunks);
  if (body.size !== accumulatedSize) {
    throw new Error("Multipart body size could not be calculated safely.");
  }
  return { body, bodySizeBytes: body.size, headers, warnings: [] };
}

async function materializeRemoteBody(
  request: RequestSpecV1,
): Promise<MaterializedRemoteBody> {
  const headers = remoteTargetHeaders(request);
  const warnings: ExecutionWarning[] = [];
  if (request.options.cookieMode !== "omit") {
    warnings.push(
      warning(
        "remote-cookie-mode-not-applied",
        "Remote relay cannot access Chrome cookies; only explicit Cookie headers are sent.",
        "options.cookieMode",
      ),
    );
  }
  if (
    request.method === "GET" ||
    request.method === "HEAD" ||
    request.body.kind === "none"
  ) {
    if (
      request.body.kind !== "none" &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      warnings.push(
        warning(
          "remote-method-body",
          `${request.method} requests cannot carry a Remote relay body.`,
          "body",
        ),
      );
    }
    return { body: undefined, bodySizeBytes: 0, headers, warnings };
  }

  const encoder = new TextEncoder();
  switch (request.body.kind) {
    case "json": {
      if (relayHeaderValue(headers, "Content-Type") === undefined) {
        setRelayHeader(
          headers,
          "Content-Type",
          request.body.mediaType ?? "application/json",
        );
      }
      const bytes = encoder.encode(request.body.text);
      assertRemoteBodySize(bytes.byteLength);
      return {
        body: new Blob([request.body.text]),
        bodySizeBytes: bytes.byteLength,
        headers,
        warnings,
      };
    }
    case "text": {
      if (
        request.body.mediaType &&
        relayHeaderValue(headers, "Content-Type") === undefined
      ) {
        setRelayHeader(headers, "Content-Type", request.body.mediaType);
      }
      const bytes = encoder.encode(request.body.text);
      assertRemoteBodySize(bytes.byteLength);
      return {
        body: new Blob([request.body.text]),
        bodySizeBytes: bytes.byteLength,
        headers,
        warnings,
      };
    }
    case "urlencoded": {
      const body = new URLSearchParams();
      for (const item of enabled(request.body.entries)) {
        body.append(item.name, item.value);
      }
      if (relayHeaderValue(headers, "Content-Type") === undefined) {
        setRelayHeader(
          headers,
          "Content-Type",
          "application/x-www-form-urlencoded;charset=UTF-8",
        );
      }
      const bytes = encoder.encode(body.toString());
      assertRemoteBodySize(bytes.byteLength);
      return {
        body: new Blob([body.toString()]),
        bodySizeBytes: bytes.byteLength,
        headers,
        warnings,
      };
    }
    case "file": {
      const file = boundFile(request.body.file);
      assertRemoteBodySize(file.size);
      if (relayHeaderValue(headers, "Content-Type") === undefined) {
        const mediaType =
          request.body.mediaType ?? request.body.file.mediaType ?? file.type;
        if (mediaType) setRelayHeader(headers, "Content-Type", mediaType);
      }
      return {
        body: file,
        bodySizeBytes: file.size,
        headers,
        warnings,
      };
    }
    case "multipart": {
      const materialized = await materializeMultipartBody(request, headers);
      return {
        ...materialized,
        warnings: [...warnings, ...materialized.warnings],
      };
    }
  }
}

function encodeMetadata(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.byteLength > REMOTE_MAX_METADATA_BYTES) {
    throw new Error("Remote request metadata exceeds 48 KiB.");
  }
  return bytesToBase64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeMetadata(value: string): unknown {
  if (!/^[\w-]*$/u.test(value)) {
    throw new Error("Remote relay returned invalid response metadata.");
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - (padded.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(`${padded}${padding}`);
  } catch {
    throw new Error("Remote relay returned invalid response metadata.");
  }
  if (binary.length > REMOTE_MAX_METADATA_BYTES) {
    throw new Error("Remote response metadata exceeds 48 KiB.");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Remote relay returned invalid response metadata.");
  }
}

export class RemoteExecutionError extends Error {
  readonly code?: string;
  readonly status: number;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "RemoteExecutionError";
    this.status = status;
    if (code !== undefined) this.code = code;
  }
}

async function remoteFailure(
  response: Response,
): Promise<RemoteExecutionError> {
  const contentLength = responseContentLength(response);
  if (
    contentLength !== undefined &&
    contentLength > REMOTE_MAX_METADATA_BYTES
  ) {
    return new RemoteExecutionError(
      `Remote relay failed with HTTP ${response.status}.`,
      response.status,
    );
  }
  let decoded: unknown;
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing body");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.byteLength;
        if (size > REMOTE_MAX_METADATA_BYTES) {
          await reader.cancel("metadata-too-large");
          throw new Error("too large");
        }
        chunks.push(result.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    decoded = JSON.parse(text);
  } catch {
    return new RemoteExecutionError(
      `Remote relay failed with HTTP ${response.status}.`,
      response.status,
    );
  }
  const result = remoteErrorEnvelopeV1Schema.safeParse(decoded);
  if (!result.success) {
    return new RemoteExecutionError(
      `Remote relay failed with HTTP ${response.status}.`,
      response.status,
    );
  }
  return new RemoteExecutionError(
    `Remote relay ${result.data.error.code}: ${result.data.error.message}`,
    response.status,
    result.data.error.code,
  );
}

function remoteExecuteUrl(profile: RemoteRelayProfileV1): URL {
  return new URL(`${normalizeRelayBaseUrl(profile.baseUrl)}/v1/execute`);
}

export async function executeRemote(
  requestInput: RequestSpecV1,
  target: Extract<ExecuteTargetV1, { kind: "remote" }>,
  options: ExecuteOptionsV1 = {},
): Promise<ResponseRecordV1> {
  const request = requestSpecV1Schema.parse(requestInput);
  assertRemoteSupported(request);
  boundFilesForRequest(request);
  if (target.token.trim() === "") {
    throw new Error("A Remote relay token is required.");
  }
  const execution = beginExecution(request.id, options);
  const { controller } = execution;
  const timeout = window.setTimeout(
    () => controller.abort("timeout"),
    request.options.timeoutMs,
  );
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
    if (
      responseMetadata.declaredBodySizeBytes !== undefined &&
      responseMetadata.declaredBodySizeBytes > capabilities.maxResponseBodyBytes
    ) {
      throw new Error("Response body exceeds the 20 MiB Remote limit.");
    }
    const bytes = await readResponseBytes(
      relayResponse,
      execution,
      Math.min(
        capabilities.maxResponseBodyBytes,
        REMOTE_MAX_RESPONSE_BODY_BYTES,
      ),
      responseMetadata.declaredBodySizeBytes,
    );
    if (controller.signal.aborted) {
      throw new DOMException("Request cancelled.", "AbortError");
    }
    const responseHeaders = responseMetadata.headers.map((header) => ({
      ...header,
      enabled: true,
    }));
    const mediaType =
      relayHeaderValue(responseMetadata.headers, "Content-Type")
        ?.split(";")[0]
        ?.trim() ?? "";
    const textBody = isTextMediaType(mediaType);
    const warnings = [...body.warnings, ...responseMetadata.warnings];
    if (
      responseMetadata.declaredBodySizeBytes !== undefined &&
      responseMetadata.declaredBodySizeBytes !== bytes.byteLength
    ) {
      warnings.push(
        warning(
          "remote-body-size-mismatch",
          `Relay declared ${responseMetadata.declaredBodySizeBytes} response bytes but sent ${bytes.byteLength}.`,
          "body",
        ),
      );
    }
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
    const result = responseRecordV1Schema.parse({
      requestId: request.id,
      executor: "remote",
      status: responseMetadata.status,
      statusText: responseMetadata.statusText,
      headers: responseHeaders,
      body: {
        kind: "inline",
        encoding: textBody ? "utf8" : "base64",
        content: textBody
          ? new TextDecoder().decode(bytes)
          : bytesToBase64(bytes),
        ...(mediaType ? { mediaType } : {}),
        sizeBytes: bytes.byteLength,
      },
      timings: {
        startedAt,
        durationMs: performance.now() - start,
        requestMs: responseMetadata.upstreamDurationMs,
      },
      redirects: responseMetadata.redirects,
      warnings,
    });
    reportProgress(execution, "complete", bytes.byteLength, bytes.byteLength);
    return result;
  } catch (error) {
    if (controller.signal.aborted) {
      const reason =
        controller.signal.reason === "timeout"
          ? "Request timed out."
          : "Request cancelled.";
      throw new DOMException(reason, "AbortError");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
    activeRequests.delete(request.id);
  }
}

export function executeRequest(
  request: RequestSpecV1,
  options: ExecuteOptionsV1 = {},
): Promise<ResponseRecordV1> {
  const target = options.target ?? { kind: "browser" };
  return target.kind === "remote"
    ? executeRemote(request, target, options)
    : executeBrowser(request, options);
}

export function cancelRequest(requestId: string): boolean {
  const execution = activeRequests.get(requestId);
  if (!execution) return false;
  execution.cancelling = true;
  reportProgress(
    execution,
    "cancelling",
    execution.lastProgress?.loadedBytes ?? 0,
    execution.lastProgress?.totalBytes,
  );
  execution.controller.abort("cancelled");
  return true;
}

export function isRequestCancelling(requestId: string): boolean {
  return activeRequests.get(requestId)?.cancelling === true;
}
