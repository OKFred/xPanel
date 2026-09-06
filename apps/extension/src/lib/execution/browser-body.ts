import type { ExecutionWarning, RequestSpecV1 } from "@xpanel/contracts";

import { boundFile } from "../file-bindings";
import { enabled, warning } from "./common";

export interface BrowserBodyResult {
  body?: BodyInit;
  warnings: ExecutionWarning[];
}

export function browserRequestBody(
  request: RequestSpecV1,
  headers: Headers,
): BrowserBodyResult {
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

export function browserBodySize(
  body: BodyInit | undefined,
): number | undefined {
  if (body === undefined) return 0;
  if (typeof body === "string") {
    return new TextEncoder().encode(body).byteLength;
  }
  if (body instanceof URLSearchParams) {
    return new TextEncoder().encode(body.toString()).byteLength;
  }
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return undefined;
}
