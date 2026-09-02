import { z } from "zod";

const timestampSchema = z.string().datetime({ offset: true });
const sha256Schema = z
  .string()
  .regex(/^[a-f\d]{64}$/i, "Expected a SHA-256 hex digest");
const durationSchema = z.number().finite().nonnegative();

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

export const responseRecordV1Schema = z
  .object({
    requestId: z.string().min(1),
    executor: z.literal("browser"),
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
