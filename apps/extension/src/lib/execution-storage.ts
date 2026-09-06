import { z } from "zod";

import {
  EXECUTION_PROTOCOL_VERSION,
  executionSummaryV1Schema,
  requestSpecV1Schema,
  responseBodySchema,
  responseRecordV1Schema,
  resultRetentionV1Schema,
  type ExecutionSummaryV1,
} from "@xpanel/contracts";

export const MEBIBYTE = 1024 * 1024;
export const DEFAULT_RESPONSE_LIMIT_BYTES = 20 * MEBIBYTE;
export const MIN_RESPONSE_LIMIT_BYTES = MEBIBYTE;
export const MAX_RESPONSE_LIMIT_BYTES = 100 * MEBIBYTE;

export const executionTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("browser") }).strict(),
  z
    .object({
      kind: z.literal("remote"),
      profileId: z.string().min(1),
    })
    .strict(),
]);
export type ExecutionTarget = z.infer<typeof executionTargetSchema>;

export const executionPayloadRecordSchema = z
  .object({
    schemaVersion: z.literal(EXECUTION_PROTOCOL_VERSION),
    handle: z.string().min(1),
    executionId: z.string().min(1),
    request: requestSpecV1Schema,
    target: executionTargetSchema,
    responseLimitBytes: z
      .number()
      .int()
      .min(MIN_RESPONSE_LIMIT_BYTES)
      .max(MAX_RESPONSE_LIMIT_BYTES),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ExecutionPayloadRecord = z.infer<
  typeof executionPayloadRecordSchema
>;

export const storedExecutionRecordSchema = z
  .object({
    summary: executionSummaryV1Schema,
    sessionId: z.string().min(1),
  })
  .strict();
export type StoredExecutionRecord = z.infer<typeof storedExecutionRecordSchema>;

export interface ExecutionFileRecord {
  key: string;
  payloadHandle: string;
  referenceId: string;
  name: string;
  mediaType: string;
  lastModified: number;
  blob: Blob;
}

const responseMetadataShape = responseRecordV1Schema.omit({ body: true });

export const storedResponseMetadataSchema = responseMetadataShape
  .extend({
    schemaVersion: z.literal(EXECUTION_PROTOCOL_VERSION),
    handle: z.string().min(1),
    executionId: z.string().min(1),
    body: responseBodySchema.omit({ kind: true, content: true }).extend({
      kind: z.literal("stored"),
    }),
    presentation: z
      .object({
        lineCount: z.number().int().positive(),
        maxLineLength: z.number().int().nonnegative(),
        prettyAvailable: z.boolean(),
      })
      .strict()
      .optional(),
    createdAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type StoredResponseMetadata = z.infer<
  typeof storedResponseMetadataSchema
>;

export interface StoredResponseBody {
  handle: string;
  executionId: string;
  blob: Blob;
  prettyBlob?: Blob;
  createdAt: string;
  expiresAt?: string;
}

export function isStoredBlob(value: unknown): value is Blob {
  return (
    typeof value === "object" &&
    value !== null &&
    "size" in value &&
    typeof value.size === "number" &&
    "arrayBuffer" in value &&
    typeof value.arrayBuffer === "function"
  );
}

export const stageExecutionInputSchema = z
  .object({
    request: requestSpecV1Schema,
    target: executionTargetSchema,
    retention: resultRetentionV1Schema.default("10m"),
    responseLimitBytes: z
      .number()
      .int()
      .min(MIN_RESPONSE_LIMIT_BYTES)
      .max(MAX_RESPONSE_LIMIT_BYTES)
      .default(DEFAULT_RESPONSE_LIMIT_BYTES),
  })
  .strict();
export type StageExecutionInput = z.input<typeof stageExecutionInputSchema>;

export interface StagedExecution {
  summary: ExecutionSummaryV1;
  payloadHandle: string;
}

export const executionPreferencesV1Schema = z
  .object({
    schemaVersion: z.literal(EXECUTION_PROTOCOL_VERSION),
    retention: resultRetentionV1Schema,
    responseLimitBytes: z
      .number()
      .int()
      .min(MIN_RESPONSE_LIMIT_BYTES)
      .max(MAX_RESPONSE_LIMIT_BYTES),
  })
  .strict();
export type ExecutionPreferencesV1 = z.infer<
  typeof executionPreferencesV1Schema
>;
