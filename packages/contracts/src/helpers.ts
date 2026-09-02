import {
  collectionFileV1Schema,
  requestSpecV1Schema,
  responseRecordV1Schema,
  type AuthSpec,
  type BodySpec,
  type CollectionFileV1,
  type FileReferenceV1,
  type ImportWarning,
  type KeyValueItem,
  type RequestSpecV1,
  type ResponseRecordV1,
} from "./schemas.js";

export const REDACTED_VALUE = "[REDACTED]";
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export interface ExportRedactionResult<T> {
  value: T;
  warnings: ImportWarning[];
}

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-access-token",
]);

const SENSITIVE_NAME_PATTERN =
  /api[-_]?key|access[-_]?token|auth[-_]?token|password|passwd|secret|session(?:id)?|token/i;

export function isSensitiveHeader(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return (
    SENSITIVE_HEADER_NAMES.has(normalized) ||
    SENSITIVE_NAME_PATTERN.test(normalized)
  );
}

export function redactHeaders(
  headers: readonly KeyValueItem[],
): KeyValueItem[] {
  return headers.map((header) =>
    header.sensitive === true || isSensitiveHeader(header.name)
      ? { ...header, value: REDACTED_VALUE, sensitive: true }
      : { ...header },
  );
}

function redactFileReference(file: FileReferenceV1): FileReferenceV1 {
  return {
    ...file,
    ...(file.pathHint === undefined ? {} : { pathHint: REDACTED_VALUE }),
    requiresReselection: true,
  };
}

function redactFileReferenceForExport(): FileReferenceV1 {
  return {
    id: REDACTED_VALUE,
    name: REDACTED_VALUE,
    requiresReselection: true,
  };
}

function redactUrlUserInfo(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = REDACTED_VALUE;
      url.password = REDACTED_VALUE;
    }
    for (const name of [...url.searchParams.keys()]) {
      if (isSensitiveHeader(name)) url.searchParams.set(name, REDACTED_VALUE);
    }
    return url.toString();
  } catch {
    return value.replace(
      /^([a-z][a-z\d+.-]*:\/\/)([^/@\s]+)@/i,
      `$1${REDACTED_VALUE}:${REDACTED_VALUE}@`,
    );
  }
}

function redactAuth(auth: AuthSpec): AuthSpec {
  switch (auth.kind) {
    case "none":
      return auth;
    case "basic":
      return { ...auth, password: REDACTED_VALUE };
    case "bearer":
      return { ...auth, token: REDACTED_VALUE };
    case "api-key":
      return { ...auth, value: REDACTED_VALUE };
    case "oauth2":
      return { ...auth, accessToken: REDACTED_VALUE };
  }
}

function redactJsonValue(value: unknown): {
  value: unknown;
  redacted: boolean;
} {
  if (Array.isArray(value)) {
    let redacted = false;
    const output = value.map((item) => {
      const result = redactJsonValue(item);
      redacted ||= result.redacted;
      return result.value;
    });
    return { value: output, redacted };
  }
  if (typeof value === "object" && value !== null) {
    let redacted = false;
    const entries: Array<[string, unknown]> = [];
    for (const [key, item] of Object.entries(value)) {
      if (isSensitiveHeader(key)) {
        entries.push([key, REDACTED_VALUE]);
        redacted = true;
      } else {
        const result = redactJsonValue(item);
        entries.push([key, result.value]);
        redacted ||= result.redacted;
      }
    }
    return { value: Object.fromEntries(entries), redacted };
  }
  return { value, redacted: false };
}

function redactJsonText(
  text: string,
):
  | { status: "valid"; text: string; redacted: boolean }
  | { status: "invalid" } {
  try {
    const parsed = JSON.parse(text) as unknown;
    const result = redactJsonValue(parsed);
    return {
      status: "valid",
      text: result.redacted ? JSON.stringify(result.value, null, 2) : text,
      redacted: result.redacted,
    };
  } catch {
    return { status: "invalid" };
  }
}

function redactBody(body: BodySpec): BodySpec {
  switch (body.kind) {
    case "none":
    case "text":
      return body;
    case "json": {
      const result = redactJsonText(body.text);
      return result.status === "valid" && result.redacted
        ? { ...body, text: result.text }
        : body;
    }
    case "urlencoded":
      return { ...body, entries: redactHeaders(body.entries) };
    case "file":
      return { ...body, file: redactFileReference(body.file) };
    case "multipart":
      return {
        ...body,
        parts: body.parts.map((part) =>
          part.kind === "file"
            ? {
                ...part,
                file: redactFileReference(part.file),
                ...(part.headers === undefined
                  ? {}
                  : { headers: redactHeaders(part.headers) }),
              }
            : {
                ...part,
                value: isSensitiveHeader(part.name)
                  ? REDACTED_VALUE
                  : part.value,
                ...(part.headers === undefined
                  ? {}
                  : { headers: redactHeaders(part.headers) }),
              },
        ),
      };
  }
}

function redactBodyForExport(body: BodySpec): ExportRedactionResult<BodySpec> {
  switch (body.kind) {
    case "none":
      return { value: body, warnings: [] };
    case "json": {
      const result = redactJsonText(body.text);
      if (result.status === "invalid") {
        return {
          value: { ...body, text: REDACTED_VALUE },
          warnings: [
            {
              code: "export.body_json_unparseable_redacted",
              message:
                "The invalid JSON body was redacted because sensitive fields could not be determined.",
              path: "body",
            },
          ],
        };
      }
      return {
        value: result.redacted ? { ...body, text: result.text } : body,
        warnings: [],
      };
    }
    case "text":
      return {
        value: { ...body, text: REDACTED_VALUE },
        warnings: [
          {
            code: "export.body_text_redacted",
            message:
              "The free-form text body was redacted because sensitive fields could not be determined.",
            path: "body",
          },
        ],
      };
    case "urlencoded":
      return {
        value: { ...body, entries: redactHeaders(body.entries) },
        warnings: [],
      };
    case "file":
      return {
        value: { ...body, file: redactFileReferenceForExport() },
        warnings: [
          {
            code: "export.file_metadata_redacted",
            message: "Raw file body metadata was redacted from the export.",
            path: "body.file",
          },
        ],
      };
    case "multipart": {
      const warnings: ImportWarning[] = [];
      return {
        value: {
          ...body,
          parts: body.parts.map((part, index) => {
            if (part.kind === "file") {
              warnings.push({
                code: "export.file_metadata_redacted",
                message: `Multipart file metadata for ${part.name} was redacted from the export.`,
                path: `body.parts.${index}.file`,
              });
              return {
                ...part,
                file: redactFileReferenceForExport(),
                ...(part.headers === undefined
                  ? {}
                  : { headers: redactHeaders(part.headers) }),
              };
            }
            return {
              ...part,
              value: isSensitiveHeader(part.name) ? REDACTED_VALUE : part.value,
              ...(part.headers === undefined
                ? {}
                : { headers: redactHeaders(part.headers) }),
            };
          }),
        },
        warnings,
      };
    }
  }
}

export function redactRequest(request: RequestSpecV1): RequestSpecV1 {
  const proxy =
    request.options.proxy === null
      ? null
      : {
          ...request.options.proxy,
          url: redactUrlUserInfo(request.options.proxy.url),
          ...(request.options.proxy.password === undefined
            ? {}
            : { password: REDACTED_VALUE }),
        };

  const caFile = request.options.tls.caFile;
  const clientCertificate = request.options.tls.clientCertificate;

  return requestSpecV1Schema.parse({
    ...request,
    url: redactUrlUserInfo(request.url),
    query: redactHeaders(request.query),
    headers: redactHeaders(request.headers),
    auth: redactAuth(request.auth),
    body: redactBody(request.body),
    options: {
      ...request.options,
      proxy,
      tls: {
        ...request.options.tls,
        ...(caFile === undefined
          ? {}
          : { caFile: redactFileReference(caFile) }),
        ...(clientCertificate === undefined
          ? {}
          : {
              clientCertificate: {
                certificate: redactFileReference(clientCertificate.certificate),
                privateKey: redactFileReference(clientCertificate.privateKey),
                ...(clientCertificate.passphrase === undefined
                  ? {}
                  : { passphrase: REDACTED_VALUE }),
              },
            }),
      },
    },
  });
}

export function redactResponse(response: ResponseRecordV1): ResponseRecordV1 {
  return responseRecordV1Schema.parse({
    ...response,
    headers: redactHeaders(response.headers),
  });
}

export function redactRequestForExport(
  request: RequestSpecV1,
): ExportRedactionResult<RequestSpecV1> {
  const persisted = redactRequest(request);
  const body = redactBodyForExport(persisted.body);
  const warnings = [...body.warnings];
  const caFile = persisted.options.tls.caFile;
  const clientCertificate = persisted.options.tls.clientCertificate;
  if (caFile) {
    warnings.push({
      code: "export.file_metadata_redacted",
      message: "CA file metadata was redacted from the export.",
      path: "options.tls.caFile",
    });
  }
  if (clientCertificate) {
    warnings.push({
      code: "export.file_metadata_redacted",
      message: "Client certificate file metadata was redacted from the export.",
      path: "options.tls.clientCertificate",
    });
  }
  return {
    value: requestSpecV1Schema.parse({
      ...persisted,
      body: body.value,
      options: {
        ...persisted.options,
        tls: {
          ...persisted.options.tls,
          ...(caFile ? { caFile: redactFileReferenceForExport() } : {}),
          ...(clientCertificate
            ? {
                clientCertificate: {
                  certificate: redactFileReferenceForExport(),
                  privateKey: redactFileReferenceForExport(),
                  ...(clientCertificate.passphrase === undefined
                    ? {}
                    : { passphrase: REDACTED_VALUE }),
                },
              }
            : {}),
        },
      },
    }),
    warnings,
  };
}

export function redactResponseForExport(
  response: ResponseRecordV1,
): ExportRedactionResult<ResponseRecordV1> {
  const persisted = redactResponse(response);
  return {
    value: responseRecordV1Schema.parse({
      ...persisted,
      body: {
        kind: "inline",
        encoding: "utf8",
        content: REDACTED_VALUE,
        ...(persisted.body.mediaType === undefined
          ? {}
          : { mediaType: persisted.body.mediaType }),
        sizeBytes: new TextEncoder().encode(REDACTED_VALUE).byteLength,
      },
    }),
    warnings: [
      {
        code: "export.response_body_redacted",
        message: "The response body was redacted from the export.",
        path: "body",
      },
    ],
  };
}

export function redactCollectionFile(
  collection: CollectionFileV1,
): CollectionFileV1 {
  return collectionFileV1Schema.parse({
    ...collection,
    requests: collection.requests.map(redactRequest),
  });
}

export function redactCollectionFileForExport(
  collection: CollectionFileV1,
): ExportRedactionResult<CollectionFileV1> {
  const warnings: ImportWarning[] = [];
  const requests = collection.requests.map((request, index) => {
    const result = redactRequestForExport(request);
    warnings.push(
      ...result.warnings.map((item) => ({
        ...item,
        path: item.path
          ? `requests.${index}.${item.path}`
          : `requests.${index}`,
      })),
    );
    return result.value;
  });
  return {
    value: collectionFileV1Schema.parse({ ...collection, requests }),
    warnings,
  };
}

function createId(): string {
  return globalThis.crypto.randomUUID();
}

export function createDefaultRequest(
  overrides: Partial<RequestSpecV1> = {},
  idFactory: () => string = createId,
): RequestSpecV1 {
  return requestSpecV1Schema.parse({
    id: idFactory(),
    name: "Untitled request",
    method: "GET",
    url: "",
    query: [],
    headers: [],
    auth: { kind: "none" },
    body: { kind: "none" },
    options: {
      redirect: "follow",
      cookieMode: "include",
      timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      proxy: null,
      tls: { verify: true },
    },
    source: { format: "manual" },
    favorite: false,
    warnings: [],
    ...overrides,
  });
}

export const createRequestSpec = createDefaultRequest;
