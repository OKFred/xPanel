import type { RelayHeaderV1 } from "@xpanel/contracts";
import { RelayError } from "./errors";

export interface TargetPolicy {
  readonly kind: "allowlist" | "public-https";
  readonly origins: ReadonlySet<string>;
}

const textEncoder = new TextEncoder();
const ZERO_SHA256 = new Uint8Array(32);
const SHA256_PATTERN = /^[a-f\d]{64}$/iu;

const BLOCKED_HOSTS = new Set([
  "instance-data",
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal",
]);
const BLOCKED_HOST_SUFFIXES = [
  ".example",
  ".home",
  ".home.arpa",
  ".internal",
  ".invalid",
  ".lan",
  ".local",
  ".localhost",
  ".onion",
  ".test",
] as const;

const CONTROLLED_HEADERS = new Set([
  "cf-connecting-ip",
  "cf-ew-via",
  "cf-ray",
  "cf-visitor",
  "cdn-loop",
  "connection",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
]);
const REQUEST_BODY_HEADERS = new Set([
  "content-encoding",
  "content-language",
  "content-location",
  "content-type",
]);

function decodeHex(value: string): Uint8Array | null {
  if (!SHA256_PATTERN.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    if (!Number.isFinite(byte)) return null;
    bytes[index] = byte;
  }
  return bytes;
}

export async function authenticateBearer(
  authorization: string | null,
  expectedDigestHex: string,
): Promise<{ authorized: boolean; configured: boolean }> {
  const match = authorization?.match(/^Bearer ([^\s]+)$/u) ?? null;
  const suppliedToken = match?.[1] ?? "";
  const suppliedDigest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", textEncoder.encode(suppliedToken)),
  );
  const configuredDigest = decodeHex(expectedDigestHex);
  const constantTimeSubtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual(
      left: ArrayBuffer | ArrayBufferView,
      right: ArrayBuffer | ArrayBufferView,
    ): boolean;
  };
  const matches = constantTimeSubtle.timingSafeEqual(
    suppliedDigest,
    configuredDigest ?? ZERO_SHA256,
  );
  return {
    authorized: match !== null && configuredDigest !== null && matches,
    configured: configuredDigest !== null,
  };
}

function canonicalConfiguredOrigin(
  value: string,
  variableName = "ALLOWED_TARGET_ORIGINS",
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RelayError(
      500,
      "internal",
      `${variableName} contains an invalid origin.`,
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new RelayError(
      500,
      "internal",
      `${variableName} must contain exact HTTPS origins.`,
    );
  }
  url.hostname = url.hostname.replace(/\.$/u, "");
  return url.origin;
}

function canonicalOriginForComparison(value: string): string {
  const url = new URL(value);
  url.hostname = url.hostname.replace(/\.$/u, "");
  return url.origin;
}

export function parseTargetPolicy(
  policyValue: string,
  allowedOriginsValue: string,
): TargetPolicy {
  const kind = policyValue.trim();
  if (kind !== "allowlist" && kind !== "public-https") {
    throw new RelayError(
      500,
      "internal",
      "TARGET_POLICY must be allowlist or public-https.",
    );
  }
  const origins = new Set(
    allowedOriginsValue
      .split(/[\s,]+/u)
      .filter((entry) => entry.length > 0)
      .map((entry) => canonicalConfiguredOrigin(entry)),
  );
  return { kind, origins };
}

export function parseRelaySelfOrigins(
  requestOrigin: string,
  configuredOriginsValue: string,
): ReadonlySet<string> {
  return new Set([
    canonicalOriginForComparison(requestOrigin),
    ...configuredOriginsValue
      .split(/[\s,]+/u)
      .filter((entry) => entry.length > 0)
      .map((entry) => canonicalConfiguredOrigin(entry, "RELAY_SELF_ORIGINS")),
  ]);
}

function isIpLiteral(hostname: string): boolean {
  const unwrapped = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  return (
    unwrapped.includes(":") || /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(unwrapped)
  );
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/u, "");
  return (
    normalized.length === 0 ||
    isIpLiteral(normalized) ||
    BLOCKED_HOSTS.has(normalized) ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
}

export function assertTargetAllowed(
  target: URL,
  policy: TargetPolicy,
  relayOrigins: string | ReadonlySet<string>,
  requestId?: string,
): void {
  if (
    target.protocol !== "https:" ||
    target.username !== "" ||
    target.password !== ""
  ) {
    throw new RelayError(
      403,
      "target_not_allowed",
      "The relay accepts credential-free HTTPS target URLs only.",
      requestId,
    );
  }
  if (isBlockedHostname(target.hostname)) {
    throw new RelayError(
      403,
      "target_not_allowed",
      "IP literals and local, private, or reserved hostnames are not allowed.",
      requestId,
    );
  }
  const knownRelayOrigins =
    typeof relayOrigins === "string"
      ? new Set([canonicalOriginForComparison(relayOrigins)])
      : relayOrigins;
  if (knownRelayOrigins.has(canonicalOriginForComparison(target.origin))) {
    throw new RelayError(
      403,
      "target_not_allowed",
      "The relay cannot send a request back to itself.",
      requestId,
    );
  }
  if (
    policy.kind === "public-https" &&
    target.port !== "" &&
    !policy.origins.has(target.origin)
  ) {
    throw new RelayError(
      403,
      "target_not_allowed",
      "Non-default HTTPS ports require an exact allowlist entry.",
      requestId,
    );
  }
  if (policy.kind === "allowlist" && !policy.origins.has(target.origin)) {
    throw new RelayError(
      403,
      "target_not_allowed",
      "The target origin is not in ALLOWED_TARGET_ORIGINS.",
      requestId,
    );
  }
}

export function assertHeadersAllowed(
  headers: readonly RelayHeaderV1[],
  requestId: string,
): void {
  for (const header of headers) {
    const name = header.name.toLowerCase();
    if (
      CONTROLLED_HEADERS.has(name) ||
      name.startsWith("cf-") ||
      name.startsWith("proxy-") ||
      name.startsWith("x-xpanel-")
    ) {
      throw new RelayError(
        400,
        "unsupported_header",
        `The ${header.name} header is controlled by the relay transport.`,
        requestId,
      );
    }
  }
}

export function toFetchHeaders(headers: readonly RelayHeaderV1[]): Headers {
  const result = new Headers();
  for (const header of headers) result.append(header.name, header.value);
  return result;
}

export function stripCrossOriginHeaders(headers: readonly RelayHeaderV1[]): {
  headers: RelayHeaderV1[];
  strippedNames: string[];
} {
  const strippedNames: string[] = [];
  const seen = new Set<string>();
  for (const header of headers) {
    const normalized = header.name.toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      strippedNames.push(header.name);
    }
  }
  return { headers: [], strippedNames };
}

export function dropBodyHeaders(
  headers: readonly RelayHeaderV1[],
): RelayHeaderV1[] {
  return headers.filter((header) => {
    const name = header.name.toLowerCase();
    return !REQUEST_BODY_HEADERS.has(name);
  });
}
