import { createHash, randomUUID } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import { TextDecoder } from "node:util";
import type { ChunkMessage, ResponseBody } from "@xpanel/contracts";
import {
  INLINE_BODY_LIMIT_BYTES,
  NATIVE_PROTOCOL_VERSION,
  TRANSFER_CHUNK_LIMIT_BYTES,
} from "./constants.js";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function isTextMediaType(mediaType: string | undefined): boolean {
  if (mediaType === undefined) return false;
  const normalized = mediaType.toLowerCase();
  return (
    normalized.startsWith("text/") ||
    normalized.includes("json") ||
    normalized.includes("xml") ||
    normalized.includes("javascript") ||
    normalized.includes("x-www-form-urlencoded") ||
    normalized === "image/svg+xml"
  );
}

function decodeUtf8(buffer: Uint8Array): string | undefined {
  try {
    return utf8Decoder.decode(buffer);
  } catch {
    return undefined;
  }
}

function withOptionalMediaType<T extends object>(
  value: T,
  mediaType: string | undefined,
): T & {
  mediaType?: string;
} {
  return mediaType === undefined ? value : { ...value, mediaType };
}

export async function emitResponseBody(
  requestId: string,
  bodyPath: string,
  mediaType: string | undefined,
  sendChunk: (message: ChunkMessage) => Promise<void>,
): Promise<ResponseBody> {
  const bodyStats = await stat(bodyPath);
  const textExpected = isTextMediaType(mediaType);

  if (bodyStats.size <= INLINE_BODY_LIMIT_BYTES) {
    const content = await readFile(bodyPath);
    const hash = createHash("sha256").update(content).digest("hex");
    const utf8 = textExpected ? decodeUtf8(content) : undefined;
    const inlineBody = withOptionalMediaType(
      {
        kind: "inline" as const,
        encoding: utf8 === undefined ? ("base64" as const) : ("utf8" as const),
        content: utf8 ?? content.toString("base64"),
        sizeBytes: content.byteLength,
        sha256: hash,
      },
      mediaType,
    );
    if (
      Buffer.byteLength(JSON.stringify(inlineBody), "utf8") <=
      INLINE_BODY_LIMIT_BYTES
    ) {
      return inlineBody;
    }
  }

  const transferId = `response-${randomUUID()}`;
  const file = await open(bodyPath, "r");
  const hash = createHash("sha256");
  const utf8Validator = new TextDecoder("utf-8", { fatal: true });
  let validUtf8 = textExpected;
  const buffer = Buffer.allocUnsafe(TRANSFER_CHUNK_LIMIT_BYTES);
  let sequence = 0;
  let position = 0;
  let digest = "";
  try {
    while (position < bodyStats.size) {
      const length = Math.min(buffer.byteLength, bodyStats.size - position);
      const { bytesRead } = await file.read(buffer, 0, length, position);
      if (bytesRead === 0) {
        throw new Error("Response file ended before its declared size.");
      }
      const content = Buffer.from(buffer.subarray(0, bytesRead));
      hash.update(content);
      position += bytesRead;
      const eof = position === bodyStats.size;
      if (validUtf8) {
        try {
          utf8Validator.decode(content, { stream: !eof });
        } catch {
          validUtf8 = false;
        }
      }
      if (eof) {
        digest = hash.digest("hex");
      }
      await sendChunk({
        version: NATIVE_PROTOCOL_VERSION,
        id: randomUUID(),
        type: "chunk",
        requestId,
        transferId,
        sequence,
        data: content.toString("base64"),
        eof,
        ...(eof ? { sha256: digest } : {}),
      });
      sequence += 1;
    }
  } finally {
    await file.close();
  }

  return withOptionalMediaType(
    {
      kind: "transfer" as const,
      encoding: validUtf8 ? ("utf8" as const) : ("base64" as const),
      transferId,
      sizeBytes: bodyStats.size,
      sha256: digest,
    },
    mediaType,
  );
}
