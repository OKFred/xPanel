import {
  responseRecordV1Schema,
  type ResponseRecordV1,
} from "@xpanel/contracts";

import { bytesToBase64, isTextMediaType } from "./common";
import type { ExecutionResponseStreamV1 } from "./types";

async function collectBytes(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      chunks.push(result.value);
      size += result.value.byteLength;
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
  return bytes;
}

export async function materializeResponse(
  response: ExecutionResponseStreamV1,
): Promise<ResponseRecordV1> {
  const bytes = await collectBytes(response.stream);
  const mediaType =
    response.headers
      .find((header) => header.name.toLowerCase() === "content-type")
      ?.value.split(";")[0]
      ?.trim() ?? "";
  const textBody = isTextMediaType(mediaType);
  return responseRecordV1Schema.parse({
    requestId: response.requestId,
    executor: response.executor,
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    body: {
      kind: "inline",
      encoding: textBody ? "utf8" : "base64",
      content: textBody
        ? new TextDecoder().decode(bytes)
        : bytesToBase64(bytes),
      ...(mediaType ? { mediaType } : {}),
      sizeBytes: bytes.byteLength,
    },
    timings: response.timings,
    redirects: response.redirects,
    warnings: response.warnings,
  });
}
