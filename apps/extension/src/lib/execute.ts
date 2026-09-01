import {
  nativeEnvelopeV1Schema,
  responseRecordV1Schema,
  type ExecutionWarning,
  type FileReferenceV1,
  type KeyValueItem,
  type NativeEnvelopeV1,
  type NativeFileDescriptorV1,
  type RequestSpecV1,
  type ResponseRecordV1,
} from "@xpanel/contracts";

import { boundFilesForRequest, type BoundNativeFile } from "./file-bindings";

export type ExecutorPreference = "auto" | "browser" | "native";

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
  "permissions-policy",
  "proxy-authorization",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
]);

const activeBrowserRequests = new Map<string, AbortController>();
const nativeRequests = new Map<string, PendingNativeRequest>();
const cancelledNativeRequests = new Set<string>();
let nativePort: chrome.runtime.Port | undefined;
let nativeHello: Deferred<void> | undefined;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

interface ResponseTransferState {
  chunks: Uint8Array[];
  nextSequence: number;
  eof: boolean;
  sha256?: string;
}

interface PendingNativeRequest {
  requestId: string;
  result: Deferred<ResponseRecordV1>;
  ready: Deferred<void>;
  uploadAcks: Map<string, Deferred<void>>;
  responseTransfers: Map<string, ResponseTransferState>;
  settled: boolean;
  timeoutId?: number;
}

function defer<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
}

function throwIfNativeCancelled(requestId: string): void {
  if (cancelledNativeRequests.has(requestId)) {
    throw new DOMException("Request cancelled.", "AbortError");
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

function requestUrl(request: RequestSpecV1): URL {
  const url = new URL(request.url);
  for (const item of enabled(request.query))
    url.searchParams.append(item.name, item.value);
  if (request.auth.kind === "api-key" && request.auth.location === "query") {
    url.searchParams.set(request.auth.name, request.auth.value);
  }
  return url;
}

function requestHeaders(
  request: RequestSpecV1,
  browserSafe: boolean,
): { headers: Headers; warnings: ExecutionWarning[] } {
  const headers = new Headers();
  const warnings: ExecutionWarning[] = [];
  for (const item of enabled(request.headers)) {
    const normalized = item.name.toLowerCase();
    if (
      browserSafe &&
      (forbiddenBrowserHeaders.has(normalized) ||
        normalized.startsWith("proxy-") ||
        normalized.startsWith("sec-"))
    ) {
      warnings.push(
        warning(
          "browser-forbidden-header",
          `Browser execution cannot set the ${item.name} header.`,
          `headers.${item.name}`,
        ),
      );
      continue;
    }
    headers.append(item.name, item.value);
  }

  switch (request.auth.kind) {
    case "basic":
      headers.set(
        "Authorization",
        `Basic ${bytesToBase64(new TextEncoder().encode(`${request.auth.username}:${request.auth.password}`))}`,
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
      if (request.auth.location === "header")
        headers.set(request.auth.name, request.auth.value);
      if (request.auth.location === "cookie") {
        warnings.push(
          warning(
            "browser-cookie-auth",
            "Browser execution cannot set an explicit Cookie value; use Native execution.",
            "auth",
          ),
        );
      }
      break;
    case "none":
      break;
  }
  return { headers, warnings };
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
      for (const item of enabled(request.body.entries))
        body.append(item.name, item.value);
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
      for (const part of request.body.parts) {
        if (!part.enabled) continue;
        if (part.kind === "text") body.append(part.name, part.value);
        else {
          warnings.push(
            warning(
              "unresolved-file",
              `File ${part.file.name} must be reselected before sending.`,
              `body.${part.name}`,
            ),
          );
        }
      }
      headers.delete("Content-Type");
      return { body, warnings };
    }
    case "file":
      throw new Error("Raw file bodies require Native execution.");
  }
}

function bytesToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function isTextMediaType(mediaType: string): boolean {
  return (
    mediaType.startsWith("text/") ||
    mediaType.includes("json") ||
    mediaType.includes("xml") ||
    mediaType.includes("javascript") ||
    mediaType.includes("yaml") ||
    mediaType === ""
  );
}

async function ensureOriginPermission(url: URL): Promise<void> {
  const originPattern = `${url.protocol}//${url.host}/*`;
  const permission = { origins: [originPattern] };
  if (await chrome.permissions.contains(permission)) return;
  const granted = await chrome.permissions.request(permission);
  if (!granted)
    throw new Error(`Host permission was not granted for ${url.origin}.`);
}

export function requiresNative(request: RequestSpecV1): boolean {
  if (["CONNECT", "TRACE", "TRACK"].includes(request.method)) return true;
  if (request.options.proxy !== null) return true;
  if (
    !request.options.tls.verify ||
    request.options.tls.caFile ||
    request.options.tls.clientCertificate
  ) {
    return true;
  }
  if (request.auth.kind === "api-key" && request.auth.location === "cookie")
    return true;
  if (request.body.kind === "file") return true;
  if (request.body.kind === "multipart") {
    if (
      request.body.parts.some(
        (part) =>
          part.kind === "file" || enabled(part.headers ?? []).length > 0,
      )
    ) {
      return true;
    }
  }
  return enabled(request.headers).some((header) => {
    const name = header.name.toLowerCase();
    return (
      forbiddenBrowserHeaders.has(name) ||
      name.startsWith("proxy-") ||
      name.startsWith("sec-")
    );
  });
}

export async function executeBrowser(
  request: RequestSpecV1,
): Promise<ResponseRecordV1> {
  const url = requestUrl(request);
  await ensureOriginPermission(url);
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const controller = new AbortController();
  activeBrowserRequests.set(request.id, controller);
  const timeout = window.setTimeout(
    () => controller.abort("timeout"),
    request.options.timeoutMs,
  );
  try {
    const headerResult = requestHeaders(request, true);
    const bodyResult = requestBody(request, headerResult.headers);
    const redirects: ResponseRecordV1["redirects"] = [];
    let requestUrl = url;
    let method = request.method;
    let body = bodyResult.body;
    let headers = headerResult.headers;
    let credentials: RequestCredentials = request.options.cookieMode;
    let response: Response;
    for (;;) {
      response = await fetch(requestUrl, {
        method,
        headers,
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
          "Browser execution cannot safely inspect this cross-origin redirect. Use Native execution or send the redirected URL explicitly.",
        );
      }
      const location = response.headers.get("location");
      if (!location) break;
      if (redirects.length >= 20)
        throw new Error("The request exceeded 20 redirects.");
      const nextUrl = new URL(location, requestUrl);
      const nextHeaders = new Headers(headers);
      const dropsBody =
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) &&
          method === "POST");
      if (nextUrl.origin !== requestUrl.origin) {
        if (body !== undefined && !dropsBody) {
          throw new Error(
            "A cross-origin redirect attempted to replay the request body. Send the redirected URL explicitly after reviewing it.",
          );
        }
        for (const name of [...nextHeaders.keys()]) {
          nextHeaders.delete(name);
        }
        credentials = "omit";
        const permission = { origins: [`${nextUrl.origin}/*`] };
        if (!(await chrome.permissions.contains(permission))) {
          throw new Error(
            `The request redirected to ${nextUrl.origin}. Review that origin and send it explicitly to grant access.`,
          );
        }
      }
      redirects.push({
        url: nextUrl.toString(),
        status: response.status,
        method,
      });
      if (dropsBody) {
        method = method === "HEAD" ? "HEAD" : "GET";
        body = undefined;
        nextHeaders.delete("content-type");
        nextHeaders.delete("content-length");
      }
      requestUrl = nextUrl;
      headers = nextHeaders;
    }
    const buffer = await response.arrayBuffer();
    const mediaType =
      response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    const content = isTextMediaType(mediaType)
      ? new TextDecoder().decode(buffer)
      : bytesToBase64(buffer);
    return responseRecordV1Schema.parse({
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
        encoding: isTextMediaType(mediaType) ? "utf8" : "base64",
        content,
        ...(mediaType ? { mediaType } : {}),
        sizeBytes: buffer.byteLength,
      },
      timings: {
        startedAt,
        durationMs: performance.now() - start,
      },
      redirects,
      warnings: [...headerResult.warnings, ...bodyResult.warnings],
    });
  } finally {
    window.clearTimeout(timeout);
    activeBrowserRequests.delete(request.id);
  }
}

function nativeError(message: string): Error {
  return new Error(`Native host: ${message}`);
}

function postNative(
  port: chrome.runtime.Port,
  message: NativeEnvelopeV1,
): void {
  const validated = nativeEnvelopeV1Schema.parse(message);
  if (
    new TextEncoder().encode(JSON.stringify(validated)).byteLength >
    1024 * 1024
  ) {
    throw nativeError("message exceeds the 1 MiB Native Messaging limit");
  }
  port.postMessage(validated);
}

function rejectPending(pending: PendingNativeRequest, reason: unknown): void {
  if (pending.settled) return;
  pending.settled = true;
  pending.ready.reject(reason);
  for (const waiter of pending.uploadAcks.values()) waiter.reject(reason);
  pending.uploadAcks.clear();
  if (pending.timeoutId !== undefined) window.clearTimeout(pending.timeoutId);
  pending.result.reject(reason);
  nativeRequests.delete(pending.requestId);
}

function resolvePending(
  pending: PendingNativeRequest,
  response: ResponseRecordV1,
): void {
  if (pending.settled) return;
  pending.settled = true;
  if (pending.timeoutId !== undefined) window.clearTimeout(pending.timeoutId);
  pending.result.resolve(response);
  nativeRequests.delete(pending.requestId);
}

function rejectAllNative(reason: unknown): void {
  nativeHello?.reject(reason);
  nativeHello = undefined;
  for (const pending of nativeRequests.values()) rejectPending(pending, reason);
}

function base64ToBytes(value: string): Uint8Array {
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1)
    bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

function concatenateBytes(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function completeTransferredResponse(
  pending: PendingNativeRequest,
  response: ResponseRecordV1,
): Promise<ResponseRecordV1> {
  if (response.body.kind !== "transfer")
    return responseRecordV1Schema.parse(response);
  const transfer = pending.responseTransfers.get(response.body.transferId);
  if (!transfer || !transfer.eof) {
    throw nativeError(
      `response transfer ${response.body.transferId} did not finish`,
    );
  }
  const bytes = concatenateBytes(transfer.chunks);
  if (bytes.byteLength !== response.body.sizeBytes) {
    throw nativeError(
      `response transfer size mismatch: expected ${response.body.sizeBytes}, received ${bytes.byteLength}`,
    );
  }
  const digest = await sha256Bytes(bytes);
  const expectedDigest = response.body.sha256 ?? transfer.sha256;
  if (expectedDigest && digest.toLowerCase() !== expectedDigest.toLowerCase()) {
    throw nativeError("response transfer checksum verification failed");
  }
  if (
    response.body.sha256 &&
    transfer.sha256 &&
    response.body.sha256.toLowerCase() !== transfer.sha256.toLowerCase()
  ) {
    throw nativeError("response transfer reported conflicting checksums");
  }

  return responseRecordV1Schema.parse({
    ...response,
    body: {
      kind: "inline",
      encoding: response.body.encoding,
      content:
        response.body.encoding === "utf8"
          ? new TextDecoder().decode(bytes)
          : bytesToBase64(bytes),
      ...(response.body.mediaType
        ? { mediaType: response.body.mediaType }
        : {}),
      sizeBytes: response.body.sizeBytes,
      sha256: digest,
    },
  });
}

async function handleNativeMessage(
  port: chrome.runtime.Port,
  raw: unknown,
): Promise<void> {
  const parsed = nativeEnvelopeV1Schema.safeParse(raw);
  if (!parsed.success)
    throw nativeError("received an invalid protocol message");
  const message = parsed.data;

  if (message.type === "hello") {
    nativeHello?.resolve(undefined);
    return;
  }
  if (message.type === "error") {
    const error = nativeError(message.message);
    if (message.requestId) {
      const pending = nativeRequests.get(message.requestId);
      if (pending) rejectPending(pending, error);
    } else {
      rejectAllNative(error);
    }
    return;
  }
  if (message.type === "ack") {
    if (!message.requestId) return;
    const pending = nativeRequests.get(message.requestId);
    if (!pending) return;
    if (message.phase === "ready") {
      pending.ready.resolve(undefined);
      return;
    }
    if (message.phase === "cancelled") {
      rejectPending(
        pending,
        new DOMException("Request cancelled.", "AbortError"),
      );
      return;
    }
    if (message.transferId !== undefined && message.sequence !== undefined) {
      const key = `${message.transferId}:${message.sequence}`;
      pending.uploadAcks.get(key)?.resolve(undefined);
      pending.uploadAcks.delete(key);
    }
    return;
  }
  if (message.type === "chunk") {
    const pending = nativeRequests.get(message.requestId);
    if (!pending) return;
    const transfer = pending.responseTransfers.get(message.transferId) ?? {
      chunks: [],
      nextSequence: 0,
      eof: false,
    };
    if (transfer.eof || message.sequence !== transfer.nextSequence) {
      throw nativeError(
        `response transfer ${message.transferId} expected sequence ${transfer.nextSequence}`,
      );
    }
    transfer.chunks.push(base64ToBytes(message.data));
    transfer.nextSequence += 1;
    transfer.eof = message.eof;
    if (message.sha256) transfer.sha256 = message.sha256;
    pending.responseTransfers.set(message.transferId, transfer);
    postNative(port, {
      version: 1,
      id: crypto.randomUUID(),
      type: "ack",
      requestId: message.requestId,
      transferId: message.transferId,
      sequence: message.sequence,
      phase: "chunk",
    });
    return;
  }
  if (message.type === "complete") {
    const pending = nativeRequests.get(message.requestId);
    if (!pending) return;
    try {
      resolvePending(
        pending,
        await completeTransferredResponse(pending, message.response),
      );
    } catch (error) {
      rejectPending(pending, error);
    }
  }
}

async function connectNativePort(): Promise<chrome.runtime.Port> {
  if (nativePort && nativeHello) {
    await withTimeout(
      nativeHello.promise,
      5_000,
      "Native host handshake timed out.",
    );
    return nativePort;
  }

  const port = chrome.runtime.connectNative("com.okfred.xpanel");
  nativePort = port;
  nativeHello = defer<void>();
  port.onMessage.addListener((message: unknown) => {
    void handleNativeMessage(port, message).catch((error: unknown) => {
      rejectAllNative(error);
      port.disconnect();
    });
  });
  port.onDisconnect.addListener(() => {
    if (nativePort !== port) return;
    const error = nativeError(
      chrome.runtime.lastError?.message ?? "connection closed",
    );
    nativePort = undefined;
    rejectAllNative(error);
  });
  postNative(port, {
    version: 1,
    id: crypto.randomUUID(),
    type: "hello",
    client: { name: "xpanel-extension", version: "2.0.0" },
    capabilities: ["chunked-upload", "chunked-response"],
  });
  try {
    await withTimeout(
      nativeHello.promise,
      5_000,
      "Native host handshake timed out.",
    );
  } catch (error) {
    if (nativePort === port) nativePort = undefined;
    port.disconnect();
    throw error;
  }
  return port;
}

async function postUploadChunk(
  port: chrome.runtime.Port,
  pending: PendingNativeRequest,
  transferId: string,
  sequence: number,
  bytes: Uint8Array,
  eof: boolean,
  sha256?: string,
): Promise<void> {
  const key = `${transferId}:${sequence}`;
  const ack = defer<void>();
  pending.uploadAcks.set(key, ack);
  postNative(port, {
    version: 1,
    id: crypto.randomUUID(),
    type: "chunk",
    requestId: pending.requestId,
    transferId,
    sequence,
    data: bytesToBase64(bytes),
    eof,
    ...(sha256 ? { sha256 } : {}),
  });
  try {
    await withTimeout(
      ack.promise,
      30_000,
      `Native upload acknowledgement timed out at ${key}.`,
    );
  } finally {
    pending.uploadAcks.delete(key);
  }
}

function quotedMultipartValue(value: string): string {
  return value.replace(/[\r\n"\\]/gu, "_");
}

function checkedMultipartHeaders(headers: KeyValueItem[] | undefined): {
  lines: string[];
  hasContentType: boolean;
} {
  const lines: string[] = [];
  let hasContentType = false;
  for (const header of enabled(headers ?? [])) {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(header.name)) {
      throw new Error(`Multipart header name ${header.name} is invalid.`);
    }
    if (/\r|\n/u.test(header.name) || /\r|\n/u.test(header.value)) {
      throw new Error(`Multipart header ${header.name} contains a line break.`);
    }
    const name = header.name.toLowerCase();
    if (
      name === "content-disposition" ||
      name === "content-length" ||
      name === "transfer-encoding"
    ) {
      throw new Error(
        `Multipart header ${header.name} is managed by xPanel and cannot be set.`,
      );
    }
    if (name === "content-type") hasContentType = true;
    lines.push(`${header.name}: ${header.value}\r\n`);
  }
  return { lines, hasContentType };
}

async function syntheticBodyBinding(
  parts: BlobPart[],
  mediaType: string,
): Promise<BoundNativeFile> {
  const file = new File(parts, "xpanel-request-body.bin", { type: mediaType });
  const reference: FileReferenceV1 = {
    id: crypto.randomUUID(),
    name: file.name,
    size: file.size,
    mediaType,
    sha256: await sha256Bytes(new Uint8Array(await file.arrayBuffer())),
    requiresReselection: false,
  };
  return { file, purpose: "body", reference };
}

function requestContentType(request: RequestSpecV1, fallback: string): string {
  return (
    enabled(request.headers).find(
      (header) => header.name.toLowerCase() === "content-type",
    )?.value ?? fallback
  );
}

export async function prepareNativePayload(request: RequestSpecV1): Promise<{
  request: RequestSpecV1;
  files: BoundNativeFile[];
}> {
  const nativeRequest = structuredClone(request);
  const boundFiles = boundFilesForRequest(request);
  if (request.body.kind === "none" || request.body.kind === "file") {
    return { request: nativeRequest, files: boundFiles };
  }

  const auxiliaryFiles = boundFiles.filter(
    (binding) => binding.purpose !== "body" && binding.purpose !== "multipart",
  );
  let bodyBinding: BoundNativeFile;
  if (request.body.kind === "json" || request.body.kind === "text") {
    const mediaType = requestContentType(
      request,
      request.body.mediaType ??
        (request.body.kind === "json"
          ? "application/json"
          : "text/plain; charset=utf-8"),
    );
    bodyBinding = await syntheticBodyBinding([request.body.text], mediaType);
  } else if (request.body.kind === "urlencoded") {
    const encoded = new URLSearchParams();
    for (const item of enabled(request.body.entries))
      encoded.append(item.name, item.value);
    const mediaType = requestContentType(
      request,
      "application/x-www-form-urlencoded;charset=UTF-8",
    );
    bodyBinding = await syntheticBodyBinding([encoded.toString()], mediaType);
  } else {
    const boundary = `xpanel-${crypto.randomUUID()}`;
    const parts: BlobPart[] = [];
    const filesById = new Map(
      boundFiles.map((binding) => [binding.reference.id, binding.file]),
    );
    for (const part of request.body.parts) {
      if (!part.enabled) continue;
      parts.push(`--${boundary}\r\n`);
      const checkedHeaders = checkedMultipartHeaders(part.headers);
      if (part.kind === "text") {
        parts.push(
          `Content-Disposition: form-data; name="${quotedMultipartValue(part.name)}"\r\n`,
        );
        parts.push(...checkedHeaders.lines, "\r\n", part.value, "\r\n");
      } else {
        const file = filesById.get(part.file.id);
        if (!file)
          throw new Error(
            `${part.file.name} must be selected again before sending.`,
          );
        parts.push(
          `Content-Disposition: form-data; name="${quotedMultipartValue(part.name)}"; filename="${quotedMultipartValue(file.name)}"\r\n`,
        );
        if (!checkedHeaders.hasContentType) {
          parts.push(
            `Content-Type: ${file.type || "application/octet-stream"}\r\n`,
          );
        }
        parts.push(...checkedHeaders.lines, "\r\n", file, "\r\n");
      }
    }
    parts.push(`--${boundary}--\r\n`);
    const mediaType = `multipart/form-data; boundary=${boundary}`;
    bodyBinding = await syntheticBodyBinding(parts, mediaType);
    nativeRequest.headers = nativeRequest.headers.filter(
      (header) => header.name.toLowerCase() !== "content-type",
    );
  }

  nativeRequest.body = {
    kind: "file",
    file: bodyBinding.reference,
    mediaType: bodyBinding.reference.mediaType,
  };
  return { request: nativeRequest, files: [...auxiliaryFiles, bodyBinding] };
}

async function uploadFiles(
  port: chrome.runtime.Port,
  pending: PendingNativeRequest,
  files: ReturnType<typeof boundFilesForRequest>,
): Promise<void> {
  const chunkSize = 512 * 1024;
  for (const binding of files) {
    const digest = await sha256Bytes(
      new Uint8Array(await binding.file.arrayBuffer()),
    );
    if (
      binding.reference.size !== binding.file.size ||
      binding.reference.sha256?.toLowerCase() !== digest.toLowerCase()
    ) {
      throw new Error(
        `${binding.reference.name} changed after it was selected; select it again.`,
      );
    }
    if (binding.file.size === 0) {
      await postUploadChunk(
        port,
        pending,
        binding.reference.id,
        0,
        new Uint8Array(),
        true,
        digest,
      );
      continue;
    }
    let sequence = 0;
    for (let offset = 0; offset < binding.file.size; offset += chunkSize) {
      const end = Math.min(offset + chunkSize, binding.file.size);
      const bytes = new Uint8Array(
        await binding.file.slice(offset, end).arrayBuffer(),
      );
      const eof = end === binding.file.size;
      await postUploadChunk(
        port,
        pending,
        binding.reference.id,
        sequence,
        bytes,
        eof,
        eof ? digest : undefined,
      );
      sequence += 1;
    }
  }
}

export async function executeNative(
  request: RequestSpecV1,
): Promise<ResponseRecordV1> {
  cancelledNativeRequests.delete(request.id);
  const granted =
    (await chrome.permissions.contains({ permissions: ["nativeMessaging"] })) ||
    (await chrome.permissions.request({ permissions: ["nativeMessaging"] }));
  if (!granted) throw new Error("Native Messaging permission was not granted.");
  throwIfNativeCancelled(request.id);

  const payload = await prepareNativePayload(request);
  throwIfNativeCancelled(request.id);
  const files = payload.files;
  const descriptors: NativeFileDescriptorV1[] = files.map((binding) => ({
    id: binding.reference.id,
    name: binding.file.name,
    size: binding.file.size,
    sha256: binding.reference.sha256 ?? "",
    purpose: binding.purpose,
  }));
  const port = await connectNativePort();
  throwIfNativeCancelled(request.id);
  const pending: PendingNativeRequest = {
    requestId: request.id,
    result: defer<ResponseRecordV1>(),
    ready: defer<void>(),
    uploadAcks: new Map(),
    responseTransfers: new Map(),
    settled: false,
  };
  if (nativeRequests.has(request.id))
    throw new Error(`Request ${request.id} is already running.`);
  nativeRequests.set(request.id, pending);
  pending.timeoutId = window.setTimeout(() => {
    if (nativePort) {
      postNative(nativePort, {
        version: 1,
        id: crypto.randomUUID(),
        type: "cancel",
        requestId: request.id,
      });
    }
    rejectPending(
      pending,
      new Error(
        "Native execution exceeded its request timeout and grace period.",
      ),
    );
  }, request.options.timeoutMs + 60_000);

  try {
    throwIfNativeCancelled(request.id);
    postNative(port, {
      version: 1,
      id: crypto.randomUUID(),
      type: "execute",
      request: payload.request,
      ...(descriptors.length > 0 ? { files: descriptors } : {}),
    });
    await withTimeout(
      pending.ready.promise,
      10_000,
      "Native host did not become ready.",
    );
    await uploadFiles(port, pending, files);
  } catch (error) {
    try {
      postNative(port, {
        version: 1,
        id: crypto.randomUUID(),
        type: "cancel",
        requestId: request.id,
      });
    } catch {
      // The original error is more useful; disconnect cleanup remains a fallback.
    }
    rejectPending(pending, error);
  }
  try {
    return await pending.result.promise;
  } finally {
    cancelledNativeRequests.delete(request.id);
  }
}

export async function executeRequest(
  request: RequestSpecV1,
  preference: ExecutorPreference,
): Promise<ResponseRecordV1> {
  if (preference === "browser" && requiresNative(request)) {
    throw new Error(
      "This request uses headers, files, proxy, cookie, or TLS options that Browser execution cannot preserve. Select Native execution.",
    );
  }
  const executor =
    preference === "auto"
      ? requiresNative(request)
        ? "native"
        : "browser"
      : preference;
  return executor === "native"
    ? executeNative(request)
    : executeBrowser(request);
}

export function cancelRequest(requestId: string): void {
  activeBrowserRequests.get(requestId)?.abort("cancelled");
  cancelledNativeRequests.add(requestId);
  const pending = nativeRequests.get(requestId);
  if (nativePort && pending) {
    postNative(nativePort, {
      version: 1,
      id: crypto.randomUUID(),
      type: "cancel",
      requestId,
    });
    rejectPending(
      pending,
      new DOMException("Request cancelled.", "AbortError"),
    );
  }
}
