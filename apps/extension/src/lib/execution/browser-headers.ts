import { requestSpecV1Schema, type RequestSpecV1 } from "@xpanel/contracts";

import { bytesToBase64, enabled, unsupportedRequestMethods } from "./common";

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
        .some((method) => unsupportedRequestMethods.has(method)))
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

/** Return every request feature that Fetch cannot reproduce faithfully. */
export function browserUnsupportedReasons(request: RequestSpecV1): string[] {
  const reasons: string[] = [];
  if (unsupportedRequestMethods.has(request.method)) {
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

export function assertBrowserSupported(request: RequestSpecV1): void {
  const reasons = browserUnsupportedReasons(request);
  if (reasons.length === 0) return;
  throw new Error(
    `Browser Fetch cannot preserve this request because it uses ${reasons.join(
      ", ",
    )}. Remove those options before sending.`,
  );
}

export function browserRequestHeaders(request: RequestSpecV1): Headers {
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
