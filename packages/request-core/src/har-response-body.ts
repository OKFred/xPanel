import type { ImportWarning, ResponseBody } from "@xpanel/contracts";

import { asString, warning } from "./common.js";

export function harResponseBody(
  content: Record<string, unknown>,
  entryIndex: number,
): { body: ResponseBody; warnings: ImportWarning[] } {
  const warnings: ImportWarning[] = [];
  const path = `log.entries.${entryIndex}.response.content`;
  const declaredSize =
    typeof content.size === "number" &&
    Number.isSafeInteger(content.size) &&
    content.size >= 0
      ? content.size
      : undefined;
  let text = asString(content.text) ?? "";
  let encoding: ResponseBody["encoding"] =
    content.encoding === "base64" ? "base64" : "utf8";
  let sizeBytes = 0;

  if (content.encoding !== undefined && content.encoding !== "base64") {
    warnings.push(
      warning(
        "har.response_encoding_unsupported",
        `HAR entry ${entryIndex + 1}: response encoding is unsupported; only response metadata was imported, not its body.`,
        path,
      ),
    );
    text = "";
    encoding = "utf8";
  } else {
    try {
      // HAR size describes the original response, not necessarily the captured
      // text. Store only the actual UTF-8 or decoded binary bytes we possess.
      sizeBytes =
        encoding === "base64"
          ? atob(text).length
          : new TextEncoder().encode(text).byteLength;
      if (
        sizeBytes === 0 &&
        ((declaredSize ?? 0) > 0 ||
          (typeof content.text !== "string" && declaredSize === undefined))
      ) {
        warnings.push(
          warning(
            "har.response_body_missing",
            `HAR entry ${entryIndex + 1}: no response body was captured (declared size: ${declaredSize ?? "unknown"}); only response metadata was imported.`,
            path,
          ),
        );
      } else if (declaredSize !== undefined && declaredSize !== sizeBytes) {
        warnings.push(
          warning(
            "har.response_size_mismatch",
            `HAR entry ${entryIndex + 1}: declares ${declaredSize} response bytes; the imported body contains ${sizeBytes} local bytes. The captured body was preserved.`,
            path,
          ),
        );
      }
    } catch {
      warnings.push(
        warning(
          "har.response_base64_invalid",
          `HAR entry ${entryIndex + 1}: response body is not valid base64; only response metadata was imported, not its body.`,
          path,
        ),
      );
      text = "";
      encoding = "utf8";
    }
  }

  return {
    body: {
      kind: "inline",
      encoding,
      content: text,
      mediaType: asString(content.mimeType),
      sizeBytes,
    },
    warnings,
  };
}
