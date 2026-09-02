import {
  REMOTE_MAX_METADATA_BYTES,
  REMOTE_PROTOCOL_VERSION,
} from "@xpanel/contracts";
import { RelayError } from "./errors";

export const PROTOCOL_HEADER = "X-XPanel-Protocol";
export const REQUEST_METADATA_HEADER = "X-XPanel-Request";
export const RESPONSE_METADATA_HEADER = "X-XPanel-Response";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const MAX_ENCODED_METADATA_LENGTH =
  Math.ceil(REMOTE_MAX_METADATA_BYTES / 3) * 4;

function bytesToBinary(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return binary;
}

export function encodeMetadata(value: unknown): string {
  const bytes = textEncoder.encode(JSON.stringify(value));
  if (bytes.byteLength > REMOTE_MAX_METADATA_BYTES) {
    throw new RelayError(
      502,
      "metadata_too_large",
      "The upstream response metadata exceeds the relay limit.",
    );
  }
  return btoa(bytesToBinary(bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function decodeMetadata(value: string | null): unknown {
  if (value === null || value.length === 0) {
    throw new RelayError(
      400,
      "invalid_metadata",
      `Missing ${REQUEST_METADATA_HEADER} header.`,
    );
  }
  if (value.length > MAX_ENCODED_METADATA_LENGTH) {
    throw new RelayError(
      413,
      "metadata_too_large",
      "The request metadata exceeds the relay limit.",
    );
  }
  if (!/^[A-Za-z\d_-]+={0,2}$/u.test(value)) {
    throw new RelayError(
      400,
      "invalid_metadata",
      "The request metadata is not valid base64url.",
    );
  }

  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );

  try {
    const binary = atob(padded);
    if (binary.length > REMOTE_MAX_METADATA_BYTES) {
      throw new RelayError(
        413,
        "metadata_too_large",
        "The request metadata exceeds the relay limit.",
      );
    }
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return JSON.parse(textDecoder.decode(bytes)) as unknown;
  } catch (error) {
    if (error instanceof RelayError) throw error;
    throw new RelayError(
      400,
      "invalid_metadata",
      "The request metadata is not valid UTF-8 JSON.",
    );
  }
}

export function assertProtocol(request: Request): void {
  if (
    request.headers.get(PROTOCOL_HEADER) !== String(REMOTE_PROTOCOL_VERSION)
  ) {
    throw new RelayError(
      400,
      "protocol_unsupported",
      `This relay supports xPanel protocol ${REMOTE_PROTOCOL_VERSION}.`,
    );
  }
}
