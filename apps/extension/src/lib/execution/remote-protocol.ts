import {
  REMOTE_MAX_METADATA_BYTES,
  remoteErrorEnvelopeV1Schema,
} from "@xpanel/contracts";

import { bytesToBase64, responseContentLength } from "./common";

export function encodeMetadata(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.byteLength > REMOTE_MAX_METADATA_BYTES) {
    throw new Error("Remote request metadata exceeds 48 KiB.");
  }
  return bytesToBase64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function decodeMetadata(value: string): unknown {
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

export async function remoteFailure(
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
