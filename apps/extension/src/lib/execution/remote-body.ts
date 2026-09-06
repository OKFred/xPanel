import {
  REMOTE_MAX_REQUEST_BODY_BYTES,
  relayHeaderV1Schema,
  type ExecutionWarning,
  type KeyValueItem,
  type RelayHeaderV1,
  type RequestSpecV1,
} from "@xpanel/contracts";

import { boundFile } from "../file-bindings";
import { enabled, warning } from "./common";
import {
  relayHeaderValue,
  remoteTargetHeaders,
  setRelayHeader,
} from "./remote-headers";

export interface MaterializedRemoteBody {
  body: BodyInit | undefined;
  bodySizeBytes: number;
  headers: RelayHeaderV1[];
  warnings: ExecutionWarning[];
}

function assertRemoteBodySize(size: number): void {
  if (size > REMOTE_MAX_REQUEST_BODY_BYTES) {
    throw new Error("Request body exceeds the 20 MiB Remote limit.");
  }
}

function safeDispositionValue(value: string): string {
  return value.replace(/["\r\n]/gu, (character) =>
    character === '"' ? "%22" : "",
  );
}

function partHeaders(
  name: string,
  customHeaders: readonly KeyValueItem[],
  file?: File,
): RelayHeaderV1[] {
  const headers = enabled(customHeaders).map((header) =>
    relayHeaderV1Schema.parse({
      name: header.name.trim(),
      value: header.value,
    }),
  );
  if (relayHeaderValue(headers, "Content-Disposition") === undefined) {
    const filename = file
      ? `; filename="${safeDispositionValue(file.name)}"`
      : "";
    headers.unshift({
      name: "Content-Disposition",
      value: `form-data; name="${safeDispositionValue(name)}"${filename}`,
    });
  }
  if (file?.type && relayHeaderValue(headers, "Content-Type") === undefined) {
    headers.push({ name: "Content-Type", value: file.type });
  }
  return headers;
}

async function deterministicMultipartBoundary(
  requestId: string,
): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(requestId)),
  );
  const suffix = [...digest]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `----xpanel-${suffix}`;
}

async function materializeMultipartBody(
  request: RequestSpecV1,
  headers: RelayHeaderV1[],
): Promise<MaterializedRemoteBody> {
  if (request.body.kind !== "multipart") {
    throw new Error("Expected a multipart request body.");
  }
  const encoder = new TextEncoder();
  const boundary = await deterministicMultipartBoundary(request.id);
  const chunks: BlobPart[] = [];
  let accumulatedSize = 0;
  const appendText = (chunk: string): void => {
    accumulatedSize += encoder.encode(chunk).byteLength;
    assertRemoteBodySize(accumulatedSize);
    chunks.push(chunk);
  };

  for (const part of request.body.parts) {
    if (!part.enabled) continue;
    const file = part.kind === "file" ? boundFile(part.file) : undefined;
    if (file) assertRemoteBodySize(accumulatedSize + file.size);
    const headersForPart = partHeaders(part.name, part.headers ?? [], file);
    appendText(`--${boundary}\r\n`);
    for (const header of headersForPart) {
      appendText(`${header.name}: ${header.value}\r\n`);
    }
    appendText("\r\n");
    if (part.kind === "file") {
      if (!file) throw new Error("The selected multipart file is unavailable.");
      chunks.push(file);
      accumulatedSize += file.size;
      assertRemoteBodySize(accumulatedSize);
    } else {
      appendText(part.value);
    }
    appendText("\r\n");
  }
  appendText(`--${boundary}--\r\n`);
  setRelayHeader(
    headers,
    "Content-Type",
    `multipart/form-data; boundary=${boundary}`,
  );
  const body = new Blob(chunks);
  if (body.size !== accumulatedSize) {
    throw new Error("Multipart body size could not be calculated safely.");
  }
  return { body, bodySizeBytes: body.size, headers, warnings: [] };
}

export async function materializeRemoteBody(
  request: RequestSpecV1,
): Promise<MaterializedRemoteBody> {
  const headers = remoteTargetHeaders(request);
  const warnings: ExecutionWarning[] = [];
  if (request.options.cookieMode !== "omit") {
    warnings.push(
      warning(
        "remote-cookie-mode-not-applied",
        "Remote relay cannot access Chrome cookies; only explicit Cookie headers are sent.",
        "options.cookieMode",
      ),
    );
  }
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
          "remote-method-body",
          `${request.method} requests cannot carry a Remote relay body.`,
          "body",
        ),
      );
    }
    return { body: undefined, bodySizeBytes: 0, headers, warnings };
  }

  const encoder = new TextEncoder();
  switch (request.body.kind) {
    case "json": {
      if (relayHeaderValue(headers, "Content-Type") === undefined) {
        setRelayHeader(
          headers,
          "Content-Type",
          request.body.mediaType ?? "application/json",
        );
      }
      const bytes = encoder.encode(request.body.text);
      assertRemoteBodySize(bytes.byteLength);
      return {
        body: new Blob([request.body.text]),
        bodySizeBytes: bytes.byteLength,
        headers,
        warnings,
      };
    }
    case "text": {
      if (
        request.body.mediaType &&
        relayHeaderValue(headers, "Content-Type") === undefined
      ) {
        setRelayHeader(headers, "Content-Type", request.body.mediaType);
      }
      const bytes = encoder.encode(request.body.text);
      assertRemoteBodySize(bytes.byteLength);
      return {
        body: new Blob([request.body.text]),
        bodySizeBytes: bytes.byteLength,
        headers,
        warnings,
      };
    }
    case "urlencoded": {
      const body = new URLSearchParams();
      for (const item of enabled(request.body.entries)) {
        body.append(item.name, item.value);
      }
      if (relayHeaderValue(headers, "Content-Type") === undefined) {
        setRelayHeader(
          headers,
          "Content-Type",
          "application/x-www-form-urlencoded;charset=UTF-8",
        );
      }
      const bytes = encoder.encode(body.toString());
      assertRemoteBodySize(bytes.byteLength);
      return {
        body: new Blob([body.toString()]),
        bodySizeBytes: bytes.byteLength,
        headers,
        warnings,
      };
    }
    case "file": {
      const file = boundFile(request.body.file);
      assertRemoteBodySize(file.size);
      if (relayHeaderValue(headers, "Content-Type") === undefined) {
        const mediaType =
          request.body.mediaType ?? request.body.file.mediaType ?? file.type;
        if (mediaType) setRelayHeader(headers, "Content-Type", mediaType);
      }
      return {
        body: file,
        bodySizeBytes: file.size,
        headers,
        warnings,
      };
    }
    case "multipart": {
      const materialized = await materializeMultipartBody(request, headers);
      return {
        ...materialized,
        warnings: [...warnings, ...materialized.warnings],
      };
    }
  }
}
