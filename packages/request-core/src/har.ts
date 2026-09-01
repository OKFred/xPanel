import {
  isSensitiveHeader,
  redactRequestForExport,
  redactResponseForExport,
  type ImportWarning,
  type KeyValueItem,
  type MultipartPart,
  type RequestSpecV1,
  type ResponseRecordV1,
} from "@xpanel/contracts";

import {
  asString,
  detectBody,
  extractStructuredAuth,
  isRecord,
  makeRequest,
  materializeAuth,
  normalizeMethod,
  safeId,
  splitUrlQuery,
  warning,
} from "./common.js";

export interface HarImportResult {
  requests: RequestSpecV1[];
  responses: ResponseRecordV1[];
  warnings: ImportWarning[];
}

export function importHar(input: string | object): HarImportResult {
  const warnings: ImportWarning[] = [];
  let root: unknown;
  try {
    root = typeof input === "string" ? JSON.parse(input) : input;
  } catch (error) {
    return {
      requests: [],
      responses: [],
      warnings: [
        warning(
          "har.parse_failed",
          `HAR JSON could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ],
    };
  }
  if (
    !isRecord(root) ||
    !isRecord(root.log) ||
    !Array.isArray(root.log.entries)
  ) {
    return {
      requests: [],
      responses: [],
      warnings: [
        warning("har.shape_invalid", "Expected a HAR 1.2 log.entries array."),
      ],
    };
  }
  if (root.log.version !== "1.2") {
    warnings.push(
      warning(
        "har.version_unexpected",
        `HAR version ${String(root.log.version)} was imported as 1.2-compatible data.`,
      ),
    );
  }

  const requests: RequestSpecV1[] = [];
  const responses: ResponseRecordV1[] = [];
  for (const [index, rawEntry] of root.log.entries.entries()) {
    if (!isRecord(rawEntry) || !isRecord(rawEntry.request)) {
      warnings.push(
        warning(
          "har.entry_invalid",
          `Skipped invalid HAR entry ${index}.`,
          `log.entries.${index}`,
        ),
      );
      continue;
    }
    const rawRequest = rawEntry.request;
    const rawUrl = asString(rawRequest.url);
    if (!rawUrl) {
      warnings.push(
        warning(
          "har.url_missing",
          `HAR entry ${index} has no URL.`,
          `log.entries.${index}`,
        ),
      );
      continue;
    }
    const split = splitUrlQuery(rawUrl);
    const headers = harNameValues(rawRequest.headers);
    const query = Array.isArray(rawRequest.queryString)
      ? harNameValues(rawRequest.queryString)
      : split.query;
    const extracted = extractStructuredAuth(headers, query);
    const body = harRequestBody(rawRequest.postData, headers, warnings, index);
    const request = makeRequest(
      { format: "har" },
      {
        name: `${normalizeMethod(asString(rawRequest.method))} ${safePath(rawUrl)}`,
        method: normalizeMethod(asString(rawRequest.method)),
        url: split.url,
        query: extracted.query,
        headers: extracted.headers,
        auth: extracted.auth,
        body,
      },
    );
    requests.push(request);

    if (isRecord(rawEntry.response)) {
      responses.push(harResponse(rawEntry, request.id, warnings, index));
    }
  }
  return { requests, responses, warnings };
}

function harRequestBody(
  rawPostData: unknown,
  headers: KeyValueItem[],
  warnings: ImportWarning[],
  entryIndex: number,
): RequestSpecV1["body"] {
  if (!isRecord(rawPostData)) return { kind: "none" };
  const mimeType = asString(rawPostData.mimeType);
  if (isRecord(rawPostData._xpanelFile)) {
    const name = asString(rawPostData._xpanelFile.name) ?? "body.bin";
    warnings.push(
      warning(
        "har.file_reselection_required",
        `HAR file body ${name} must be selected again.`,
        `log.entries.${entryIndex}.request.postData._xpanelFile`,
      ),
    );
    return {
      kind: "file",
      file: {
        id: safeId("body"),
        name,
        requiresReselection: true,
      },
      ...(mimeType ? { mediaType: mimeType } : {}),
    };
  }
  const params = Array.isArray(rawPostData.params) ? rawPostData.params : [];
  if (mimeType?.includes("multipart/form-data")) {
    const parts: MultipartPart[] = params.flatMap(
      (rawParam): MultipartPart[] => {
        if (!isRecord(rawParam) || typeof rawParam.name !== "string") return [];
        const fileName = asString(rawParam.fileName);
        if (fileName) {
          warnings.push(
            warning(
              "har.file_reselection_required",
              `HAR file ${fileName} must be selected again.`,
              `log.entries.${entryIndex}.request.postData.params`,
            ),
          );
          return [
            {
              kind: "file" as const,
              name: rawParam.name,
              enabled: true,
              file: {
                id: safeId("file"),
                name: fileName,
                ...(asString(rawParam.contentType)
                  ? { mediaType: asString(rawParam.contentType) }
                  : {}),
                requiresReselection: true,
              },
            },
          ];
        }
        return [
          {
            kind: "text" as const,
            name: rawParam.name,
            value: asString(rawParam.value) ?? "",
            enabled: true,
          },
        ];
      },
    );
    return { kind: "multipart", parts };
  }
  if (
    mimeType?.includes("application/x-www-form-urlencoded") &&
    params.length
  ) {
    return { kind: "urlencoded", entries: harNameValues(params) };
  }
  if (
    mimeType &&
    !headers.some((item) => item.name.toLowerCase() === "content-type")
  ) {
    headers.push({ name: "Content-Type", value: mimeType, enabled: true });
  }
  return detectBody(asString(rawPostData.text), headers);
}

function harResponse(
  entry: Record<string, unknown>,
  requestId: string,
  warnings: ImportWarning[],
  entryIndex: number,
): ResponseRecordV1 {
  const response = isRecord(entry.response) ? entry.response : {};
  const content = isRecord(response.content) ? response.content : {};
  const text = asString(content.text) ?? "";
  const encoding = content.encoding === "base64" ? "base64" : "utf8";
  const startedAt = validTimestamp(entry.startedDateTime);
  const durationMs = nonnegativeNumber(entry.time) ?? 0;
  const timings = isRecord(entry.timings) ? entry.timings : {};
  const status = integer(response.status) ?? 0;
  const redirectUrl = asString(response.redirectURL);
  return {
    requestId,
    executor: "browser",
    status,
    statusText: asString(response.statusText) ?? "",
    headers: harNameValues(response.headers),
    body: {
      kind: "inline",
      encoding,
      content: text,
      mediaType: asString(content.mimeType),
      sizeBytes: integer(content.size) ?? byteLength(text),
    },
    timings: {
      startedAt,
      durationMs,
      dnsMs: harTiming(timings.dns),
      connectMs: harTiming(timings.connect),
      tlsMs: harTiming(timings.ssl),
      requestMs: harTiming(timings.send),
      ttfbMs: harTiming(timings.wait),
      downloadMs: harTiming(timings.receive),
    },
    redirects: redirectUrl
      ? [
          {
            url: redirectUrl,
            status: status >= 100 ? status : 302,
            method: normalizeMethod(
              asString(
                isRecord(entry.request) ? entry.request.method : undefined,
              ),
            ),
          },
        ]
      : [],
    warnings:
      text === "" && integer(content.size) && integer(content.size)! > 0
        ? [
            {
              code: "har.response_body_missing",
              message:
                "The HAR recorded a response size but did not include its body.",
              path: `log.entries.${entryIndex}.response.content`,
            },
          ]
        : [],
  };
}

export function exportHar(
  inputs: RequestSpecV1[],
  responses: ResponseRecordV1[] = [],
  options: { includeSensitive?: boolean } = {},
): Record<string, unknown> {
  return exportHarWithWarnings(inputs, responses, options).value;
}

export function exportHarWithWarnings(
  inputs: RequestSpecV1[],
  responses: ResponseRecordV1[] = [],
  options: { includeSensitive?: boolean } = {},
): { value: Record<string, unknown>; warnings: ImportWarning[] } {
  const responseByRequest = new Map(
    responses.map((response) => [response.requestId, response]),
  );
  const warnings: ImportWarning[] = [];
  const entries = inputs.map((input, index) => {
    const preparedRequest = options.includeSensitive
      ? { value: structuredClone(input), warnings: [] }
      : redactRequestForExport(input);
    warnings.push(
      ...preparedRequest.warnings.map((item) => ({
        ...item,
        path: item.path
          ? `entries.${index}.request.${item.path}`
          : `entries.${index}.request`,
      })),
    );
    const request = materializeAuth(preparedRequest.value);
    const rawResponse = responseByRequest.get(request.id);
    const preparedResponse = rawResponse
      ? options.includeSensitive
        ? { value: structuredClone(rawResponse), warnings: [] }
        : redactResponseForExport(rawResponse)
      : undefined;
    if (preparedResponse) {
      warnings.push(
        ...preparedResponse.warnings.map((item) => ({
          ...item,
          path: item.path
            ? `entries.${index}.response.${item.path}`
            : `entries.${index}.response`,
        })),
      );
    }
    return harEntry(request, preparedResponse?.value);
  });
  return {
    value: {
      log: {
        version: "1.2",
        creator: { name: "xPanel", version: "2.0.0" },
        entries,
      },
    },
    warnings,
  };
}

function harEntry(
  request: RequestSpecV1,
  response: ResponseRecordV1 | undefined,
): Record<string, unknown> {
  const url = new URL(request.url);
  for (const item of request.query.filter((entry) => entry.enabled !== false)) {
    url.searchParams.append(item.name, item.value);
  }
  const startedAt = response?.timings.startedAt ?? new Date().toISOString();
  return {
    startedDateTime: startedAt,
    time: response?.timings.durationMs ?? 0,
    request: {
      method: request.method,
      url: url.toString(),
      httpVersion: "HTTP/1.1",
      headers: toHarNameValues(request.headers),
      queryString: toHarNameValues(request.query),
      cookies: cookieHeaderToHar(request.headers),
      headersSize: -1,
      bodySize: requestBodySize(request),
      ...(request.body.kind === "none"
        ? {}
        : { postData: requestPostData(request) }),
    },
    response: response
      ? {
          status: response.status,
          statusText: response.statusText,
          httpVersion: "HTTP/1.1",
          headers: toHarNameValues(response.headers),
          cookies: setCookieHeadersToHar(response.headers),
          content: responseContent(response),
          redirectURL: response.redirects.at(-1)?.url ?? "",
          headersSize: -1,
          bodySize: response.body.sizeBytes,
        }
      : emptyHarResponse(),
    cache: {},
    timings: response ? responseTimings(response) : defaultHarTimings(),
  };
}

function requestPostData(request: RequestSpecV1): Record<string, unknown> {
  switch (request.body.kind) {
    case "none":
      return {};
    case "json":
    case "text":
      return {
        mimeType:
          request.body.mediaType ??
          (request.body.kind === "json" ? "application/json" : "text/plain"),
        text: request.body.text,
      };
    case "urlencoded":
      return {
        mimeType: "application/x-www-form-urlencoded",
        params: toHarNameValues(request.body.entries),
        text: new URLSearchParams(
          request.body.entries
            .filter((entry) => entry.enabled !== false)
            .map((entry) => [entry.name, entry.value]),
        ).toString(),
      };
    case "multipart":
      return {
        mimeType: "multipart/form-data",
        params: request.body.parts
          .filter((part) => part.enabled !== false)
          .map((part) =>
            part.kind === "file"
              ? {
                  name: part.name,
                  fileName: part.file.name,
                  contentType: part.file.mediaType,
                }
              : { name: part.name, value: part.value },
          ),
      };
    case "file":
      return {
        mimeType: request.body.mediaType ?? "application/octet-stream",
        _xpanelFile: {
          name: request.body.file.name,
          requiresReselection: true,
        },
        comment: "xPanel file reference; bytes are not embedded in HAR.",
      };
  }
}

function requestBodySize(request: RequestSpecV1): number {
  if (request.body.kind === "json" || request.body.kind === "text") {
    return byteLength(request.body.text);
  }
  if (request.body.kind === "urlencoded") {
    return byteLength(
      new URLSearchParams(
        request.body.entries.map((entry) => [entry.name, entry.value]),
      ).toString(),
    );
  }
  if (request.body.kind === "file") return request.body.file.size ?? -1;
  return -1;
}

function responseContent(response: ResponseRecordV1): Record<string, unknown> {
  if (response.body.kind === "transfer") {
    return {
      size: response.body.sizeBytes,
      mimeType: response.body.mediaType ?? "application/octet-stream",
      comment: `Body is stored in xPanel transfer ${response.body.transferId}.`,
    };
  }
  return {
    size: response.body.sizeBytes,
    mimeType: response.body.mediaType ?? "application/octet-stream",
    text: response.body.content,
    ...(response.body.encoding === "base64" ? { encoding: "base64" } : {}),
  };
}

function responseTimings(response: ResponseRecordV1): Record<string, number> {
  return {
    blocked: 0,
    dns: response.timings.dnsMs ?? -1,
    connect: response.timings.connectMs ?? -1,
    ssl: response.timings.tlsMs ?? -1,
    send: response.timings.requestMs ?? 0,
    wait: response.timings.ttfbMs ?? 0,
    receive: response.timings.downloadMs ?? 0,
  };
}

function defaultHarTimings(): Record<string, number> {
  return {
    blocked: 0,
    dns: -1,
    connect: -1,
    ssl: -1,
    send: 0,
    wait: 0,
    receive: 0,
  };
}

function emptyHarResponse(): Record<string, unknown> {
  return {
    status: 0,
    statusText: "",
    httpVersion: "",
    headers: [],
    cookies: [],
    content: { size: 0, mimeType: "application/octet-stream" },
    redirectURL: "",
    headersSize: -1,
    bodySize: -1,
  };
}

function harNameValues(value: unknown): KeyValueItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.name !== "string") return [];
    const name = item.name;
    return [
      {
        name,
        value: asString(item.value) ?? "",
        enabled: true,
        ...(isSensitiveHeader(name) ? { sensitive: true } : {}),
      },
    ];
  });
}

function toHarNameValues(
  items: KeyValueItem[],
): Array<{ name: string; value: string }> {
  return items
    .filter((item) => item.enabled !== false)
    .map((item) => ({ name: item.name, value: item.value }));
}

function cookieHeaderToHar(
  headers: KeyValueItem[],
): Array<{ name: string; value: string }> {
  return headers
    .filter((header) => header.name.toLowerCase() === "cookie")
    .flatMap((header) =>
      header.value.split(";").flatMap((part) => {
        const index = part.indexOf("=");
        return index < 0
          ? []
          : [
              {
                name: part.slice(0, index).trim(),
                value: part.slice(index + 1).trim(),
              },
            ];
      }),
    );
}

function setCookieHeadersToHar(
  headers: KeyValueItem[],
): Array<{ name: string; value: string }> {
  return headers
    .filter((header) => header.name.toLowerCase() === "set-cookie")
    .map((header) => {
      const pair = header.value.split(";")[0] ?? "";
      const index = pair.indexOf("=");
      return {
        name: index < 0 ? pair : pair.slice(0, index),
        value: index < 0 ? "" : pair.slice(index + 1),
      };
    });
}

function safePath(value: string): string {
  try {
    return new URL(value).pathname;
  } catch {
    return value;
  }
}

function validTimestamp(value: unknown): string {
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return new Date(0).toISOString();
}

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function harTiming(value: unknown): number | undefined {
  return nonnegativeNumber(value);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
