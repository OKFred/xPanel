import type {
  ExecutionWarning,
  KeyValueItem,
  RequestSpecV1,
} from "@xpanel/contracts";

const MEBIBYTE = 1024 * 1024;
export const DEFAULT_MAX_RESPONSE_BYTES = 20 * MEBIBYTE;
const MIN_MAX_RESPONSE_BYTES = MEBIBYTE;
const MAX_MAX_RESPONSE_BYTES = 100 * MEBIBYTE;

export const unsupportedRequestMethods = new Set(["CONNECT", "TRACE", "TRACK"]);

export function enabled(items: readonly KeyValueItem[]): KeyValueItem[] {
  return items.filter((item) => item.enabled && item.name.trim() !== "");
}

export function warning(
  code: string,
  message: string,
  path?: string,
): ExecutionWarning {
  return { code, message, ...(path ? { path } : {}) };
}

export function requestUrl(request: RequestSpecV1): URL {
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

export function bytesToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function isTextMediaType(mediaType: string): boolean {
  return (
    mediaType.startsWith("text/") ||
    mediaType.includes("json") ||
    mediaType.includes("xml") ||
    mediaType.includes("javascript") ||
    mediaType.includes("yaml")
  );
}

export function responseContentLength(response: Response): number | undefined {
  const value = response.headers.get("content-length");
  if (value === null || !/^\d+$/u.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function resolveMaximumResponseBytes(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < MIN_MAX_RESPONSE_BYTES ||
    resolved > MAX_MAX_RESPONSE_BYTES
  ) {
    throw new Error(
      "maximumResponseBytes must be an integer between 1 MiB and 100 MiB.",
    );
  }
  return resolved;
}
