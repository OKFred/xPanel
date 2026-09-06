import {
  relayHeaderV1Schema,
  type RelayHeaderV1,
  type RequestSpecV1,
} from "@xpanel/contracts";

import { bytesToBase64, enabled, unsupportedRequestMethods } from "./common";

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
  if (unsupportedRequestMethods.has(request.method)) {
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

export function assertRemoteSupported(request: RequestSpecV1): void {
  const reasons = remoteUnsupportedReasons(request);
  if (reasons.length === 0) return;
  throw new Error(
    `Remote relay cannot preserve this request because it uses ${reasons.join(
      ", ",
    )}. Remove those options before sending.`,
  );
}

export function setRelayHeader(
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

export function relayHeaderValue(
  headers: readonly RelayHeaderV1[],
  name: string,
): string | undefined {
  const normalized = name.toLowerCase();
  return headers.find((header) => header.name.toLowerCase() === normalized)
    ?.value;
}

export function remoteTargetHeaders(request: RequestSpecV1): RelayHeaderV1[] {
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
