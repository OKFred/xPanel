import {
  responseRecordV1Schema,
  type ExecutionWarning,
  type KeyValueItem,
  type RequestSpecV1,
  type ResponseRecordV1,
} from "@xpanel/contracts";

import { boundFile, boundFilesForRequest } from "./file-bindings";

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

function isForbiddenBrowserHeader(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return (
    forbiddenBrowserHeaders.has(normalized) ||
    normalized.startsWith("proxy-") ||
    normalized.startsWith("sec-")
  );
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
      isForbiddenBrowserHeader(request.auth.name)
    ) {
      reasons.push(`the forbidden ${request.auth.name} header`);
    }
  }
  for (const header of enabled(request.headers)) {
    if (isForbiddenBrowserHeader(header.name)) {
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

export async function executeBrowser(
  request: RequestSpecV1,
): Promise<ResponseRecordV1> {
  assertBrowserSupported(request);
  // Validate session-only file bindings before requesting site access.
  boundFilesForRequest(request);
  const url = requestUrl(request);
  const controller = new AbortController();
  activeBrowserRequests.set(request.id, controller);
  const timeout = window.setTimeout(
    () => controller.abort("timeout"),
    request.options.timeoutMs,
  );

  try {
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

    const buffer = await response.arrayBuffer();
    const mediaType =
      response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    const textBody = isTextMediaType(mediaType);
    const content = textBody
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
        encoding: textBody ? "utf8" : "base64",
        content,
        ...(mediaType ? { mediaType } : {}),
        sizeBytes: buffer.byteLength,
      },
      timings: {
        startedAt,
        durationMs: performance.now() - start,
      },
      redirects,
      warnings: bodyResult.warnings,
    });
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
    activeBrowserRequests.delete(request.id);
  }
}

export function executeRequest(
  request: RequestSpecV1,
): Promise<ResponseRecordV1> {
  return executeBrowser(request);
}

export function cancelRequest(requestId: string): void {
  activeBrowserRequests.get(requestId)?.abort("cancelled");
}
