import { z } from "zod";

const timestampSchema = z.string().datetime({ offset: true });
const sha256Schema = z
  .string()
  .regex(/^[a-f\d]{64}$/i, "Expected a SHA-256 hex digest");
const durationSchema = z.number().finite().nonnegative();

export const REMOTE_PROTOCOL_VERSION = 1 as const;
export const REMOTE_MAX_METADATA_BYTES = 48 * 1024;
export const REMOTE_MAX_REQUEST_BODY_BYTES = 20 * 1024 * 1024;
export const REMOTE_MAX_RESPONSE_BODY_BYTES = 20 * 1024 * 1024;

const httpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "Expected an HTTP or HTTPS URL");

const remoteRelayBaseUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      !value.includes("?") &&
      !value.includes("#")
    );
  }, "Expected an HTTPS relay URL without userinfo, query, or fragment");

export const keyValueItemSchema = z
  .object({
    name: z.string(),
    value: z.string(),
    enabled: z.boolean(),
    sensitive: z.boolean().optional(),
  })
  .strict();
export type KeyValueItem = z.infer<typeof keyValueItemSchema>;

export const importWarningSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    path: z.string().optional(),
  })
  .strict();
export type ImportWarning = z.infer<typeof importWarningSchema>;

export const executionWarningSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    path: z.string().optional(),
  })
  .strict();
export type ExecutionWarning = z.infer<typeof executionWarningSchema>;

export const importSourceSchema = z
  .object({
    format: z.enum([
      "manual",
      "curl-bash",
      "powershell",
      "fetch",
      "har",
      "openapi",
      "swagger",
      "collection",
      "devtools-har",
    ]),
    label: z.string().optional(),
    importedAt: timestampSchema.optional(),
  })
  .strict();
export type ImportSource = z.infer<typeof importSourceSchema>;

export const fileReferenceV1Schema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    size: z.number().int().nonnegative().optional(),
    mediaType: z.string().min(1).optional(),
    sha256: sha256Schema.optional(),
    pathHint: z.string().min(1).optional(),
    requiresReselection: z.boolean(),
  })
  .strict();
export type FileReferenceV1 = z.infer<typeof fileReferenceV1Schema>;

export const authSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("basic"),
      username: z.string(),
      password: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("bearer"),
      token: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("api-key"),
      location: z.enum(["header", "query", "cookie"]),
      name: z.string().min(1),
      value: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("oauth2"),
      accessToken: z.string(),
      tokenType: z.string().min(1),
    })
    .strict(),
]);
export type AuthSpec = z.infer<typeof authSpecSchema>;

export const multipartTextPartSchema = z
  .object({
    kind: z.literal("text"),
    name: z.string(),
    value: z.string(),
    enabled: z.boolean(),
    headers: z.array(keyValueItemSchema).optional(),
  })
  .strict();
export type MultipartTextPart = z.infer<typeof multipartTextPartSchema>;

export const multipartFilePartSchema = z
  .object({
    kind: z.literal("file"),
    name: z.string(),
    file: fileReferenceV1Schema,
    enabled: z.boolean(),
    headers: z.array(keyValueItemSchema).optional(),
  })
  .strict();
export type MultipartFilePart = z.infer<typeof multipartFilePartSchema>;

export const multipartPartSchema = z.discriminatedUnion("kind", [
  multipartTextPartSchema,
  multipartFilePartSchema,
]);
export type MultipartPart = z.infer<typeof multipartPartSchema>;

export const bodySpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("text"),
      text: z.string(),
      mediaType: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("json"),
      text: z.string(),
      mediaType: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("urlencoded"),
      entries: z.array(keyValueItemSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal("multipart"),
      parts: z.array(multipartPartSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal("file"),
      file: fileReferenceV1Schema,
      mediaType: z.string().min(1).optional(),
    })
    .strict(),
]);
export type BodySpec = z.infer<typeof bodySpecSchema>;

export const proxySpecSchema = z
  .object({
    url: z.string().min(1),
    username: z.string().optional(),
    password: z.string().optional(),
    bypass: z.array(z.string()),
  })
  .strict();
export type ProxySpec = z.infer<typeof proxySpecSchema>;

export const clientCertificateSpecSchema = z
  .object({
    certificate: fileReferenceV1Schema,
    privateKey: fileReferenceV1Schema,
    passphrase: z.string().optional(),
  })
  .strict();
export type ClientCertificateSpec = z.infer<typeof clientCertificateSpecSchema>;

export const tlsSpecSchema = z
  .object({
    verify: z.boolean(),
    caFile: fileReferenceV1Schema.optional(),
    clientCertificate: clientCertificateSpecSchema.optional(),
  })
  .strict();
export type TlsSpec = z.infer<typeof tlsSpecSchema>;

export const requestOptionsSchema = z
  .object({
    redirect: z.enum(["follow", "manual", "error"]),
    cookieMode: z.enum(["include", "same-origin", "omit"]),
    timeoutMs: z.number().int().positive().max(86_400_000),
    proxy: proxySpecSchema.nullable(),
    tls: tlsSpecSchema,
  })
  .strict();
export type RequestOptions = z.infer<typeof requestOptionsSchema>;

export const requestSpecV1Schema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    method: z
      .string()
      .regex(/^[A-Z][A-Z\d-]*$/, "Expected an uppercase HTTP method"),
    url: z.string(),
    query: z.array(keyValueItemSchema),
    headers: z.array(keyValueItemSchema),
    auth: authSpecSchema,
    body: bodySpecSchema,
    options: requestOptionsSchema,
    source: importSourceSchema,
    favorite: z.boolean(),
    warnings: z.array(importWarningSchema),
  })
  .strict();
export type RequestSpecV1 = z.infer<typeof requestSpecV1Schema>;

export const executorV1Schema = z.enum(["browser", "remote"]);
export type ExecutorV1 = z.infer<typeof executorV1Schema>;

export const executionProgressV1Schema = z
  .object({
    phase: z.enum([
      "preparing",
      "requesting-permission",
      "uploading",
      "waiting",
      "downloading",
      "cancelling",
      "complete",
    ]),
    loadedBytes: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative().optional(),
    elapsedMs: durationSchema,
  })
  .strict();
export type ExecutionProgressV1 = z.infer<typeof executionProgressV1Schema>;

export const relayHeaderV1Schema = z
  .object({
    name: z
      .string()
      .regex(
        /^[!#$%&'*+\-.^_`|~\dA-Za-z]+$/,
        "Expected a valid HTTP header name",
      ),
    value: z
      .string()
      .refine(
        (value) => !/[\r\n]/.test(value),
        "HTTP header values cannot contain line breaks",
      ),
  })
  .strict();
export type RelayHeaderV1 = z.infer<typeof relayHeaderV1Schema>;

export const remoteRelayProfileV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    name: z.string().min(1),
    baseUrl: remoteRelayBaseUrlSchema,
    tokenStorage: z.enum(["session", "local"]),
  })
  .strict();
export type RemoteRelayProfileV1 = z.infer<typeof remoteRelayProfileV1Schema>;

export const remoteRequestMetaV1Schema = z
  .object({
    protocolVersion: z.literal(REMOTE_PROTOCOL_VERSION),
    requestId: z.string().min(1),
    method: z
      .string()
      .regex(/^[A-Z][A-Z\d-]*$/, "Expected an uppercase HTTP method"),
    url: httpUrlSchema,
    headers: z.array(relayHeaderV1Schema),
    redirect: z.enum(["follow", "manual", "error"]),
    timeoutMs: z.number().int().positive().max(86_400_000),
    bodySizeBytes: z
      .number()
      .int()
      .nonnegative()
      .max(REMOTE_MAX_REQUEST_BODY_BYTES),
  })
  .strict();
export type RemoteRequestMetaV1 = z.infer<typeof remoteRequestMetaV1Schema>;

export const responseBodySchema = z
  .object({
    kind: z.literal("inline"),
    encoding: z.enum(["utf8", "base64"]),
    content: z.string(),
    mediaType: z.string().min(1).optional(),
    sizeBytes: z.number().int().nonnegative(),
    sha256: sha256Schema.optional(),
  })
  .strict();
export type ResponseBody = z.infer<typeof responseBodySchema>;

export const timingInfoSchema = z
  .object({
    startedAt: timestampSchema,
    durationMs: durationSchema,
    dnsMs: durationSchema.optional(),
    connectMs: durationSchema.optional(),
    tlsMs: durationSchema.optional(),
    requestMs: durationSchema.optional(),
    ttfbMs: durationSchema.optional(),
    downloadMs: durationSchema.optional(),
  })
  .strict();
export type TimingInfo = z.infer<typeof timingInfoSchema>;

export const redirectRecordSchema = z
  .object({
    url: z.string(),
    status: z.number().int().min(100).max(999),
    method: z.string().regex(/^[A-Z][A-Z\d-]*$/),
    durationMs: durationSchema.optional(),
  })
  .strict();
export type RedirectRecord = z.infer<typeof redirectRecordSchema>;

export const remoteResponseMetaV1Schema = z
  .object({
    protocolVersion: z.literal(REMOTE_PROTOCOL_VERSION),
    requestId: z.string().min(1),
    status: z.number().int().min(0).max(999),
    statusText: z.string(),
    headers: z.array(relayHeaderV1Schema),
    redirects: z.array(redirectRecordSchema),
    upstreamDurationMs: durationSchema,
    declaredBodySizeBytes: z
      .number()
      .int()
      .nonnegative()
      .max(REMOTE_MAX_RESPONSE_BODY_BYTES)
      .optional(),
    warnings: z.array(executionWarningSchema),
  })
  .strict();
export type RemoteResponseMetaV1 = z.infer<typeof remoteResponseMetaV1Schema>;

export const remoteCapabilitiesV1Schema = z
  .object({
    protocolVersion: z.literal(REMOTE_PROTOCOL_VERSION),
    provider: z.literal("cloudflare"),
    targetPolicy: z.enum(["allowlist", "public-https"]),
    maxMetadataBytes: z.literal(REMOTE_MAX_METADATA_BYTES),
    maxRequestBodyBytes: z.literal(REMOTE_MAX_REQUEST_BODY_BYTES),
    maxResponseBodyBytes: z.literal(REMOTE_MAX_RESPONSE_BODY_BYTES),
    features: z
      .object({
        explicitCookie: z.literal(true),
        responseSetCookie: z.literal(true),
        files: z.literal(true),
        multipart: z.literal(true),
        proxy: z.literal(false),
        customTls: z.literal(false),
        clientCertificate: z.literal(false),
      })
      .strict(),
  })
  .strict();
export type RemoteCapabilitiesV1 = z.infer<typeof remoteCapabilitiesV1Schema>;

export const REMOTE_ERROR_CODES = [
  "protocol_unsupported",
  "invalid_metadata",
  "unauthorized",
  "target_not_allowed",
  "unsupported_request",
  "unsupported_header",
  "metadata_too_large",
  "payload_too_large",
  "response_too_large",
  "redirect_disallowed",
  "timeout",
  "cancelled",
  "upstream_network",
  "internal",
] as const;

export const remoteErrorCodeV1Schema = z.enum(REMOTE_ERROR_CODES);
export type RemoteErrorCodeV1 = z.infer<typeof remoteErrorCodeV1Schema>;

export const remoteErrorEnvelopeV1Schema = z
  .object({
    protocolVersion: z.literal(REMOTE_PROTOCOL_VERSION),
    requestId: z.string().min(1).optional(),
    error: z
      .object({
        code: remoteErrorCodeV1Schema,
        message: z.string().min(1).max(4_096),
      })
      .strict(),
  })
  .strict();
export type RemoteErrorEnvelopeV1 = z.infer<typeof remoteErrorEnvelopeV1Schema>;

export const responseRecordV1Schema = z
  .object({
    requestId: z.string().min(1),
    executor: executorV1Schema,
    status: z.number().int().min(0).max(999),
    statusText: z.string(),
    headers: z.array(keyValueItemSchema),
    body: responseBodySchema,
    timings: timingInfoSchema,
    redirects: z.array(redirectRecordSchema),
    warnings: z.array(executionWarningSchema),
  })
  .strict();
export type ResponseRecordV1 = z.infer<typeof responseRecordV1Schema>;

export const collectionRecordSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string(),
    requestIds: z.array(z.string().min(1)),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export type CollectionRecord = z.infer<typeof collectionRecordSchema>;

export const collectionFileV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    exportedAt: timestampSchema,
    collections: z.array(collectionRecordSchema),
    requests: z.array(requestSpecV1Schema),
  })
  .strict();
export type CollectionFileV1 = z.infer<typeof collectionFileV1Schema>;

// PascalCase aliases keep call sites readable and make the runtime schemas
// discoverable next to their TypeScript counterparts.
export const RequestSpecV1Schema = requestSpecV1Schema;
export const ResponseRecordV1Schema = responseRecordV1Schema;
export const CollectionFileV1Schema = collectionFileV1Schema;
export const ExecutorV1Schema = executorV1Schema;
export const ExecutionProgressV1Schema = executionProgressV1Schema;
export const RelayHeaderV1Schema = relayHeaderV1Schema;
export const RemoteRelayProfileV1Schema = remoteRelayProfileV1Schema;
export const RemoteRequestMetaV1Schema = remoteRequestMetaV1Schema;
export const RemoteResponseMetaV1Schema = remoteResponseMetaV1Schema;
export const RemoteCapabilitiesV1Schema = remoteCapabilitiesV1Schema;
export const RemoteErrorCodeV1Schema = remoteErrorCodeV1Schema;
export const RemoteErrorEnvelopeV1Schema = remoteErrorEnvelopeV1Schema;
