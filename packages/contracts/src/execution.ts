import { z } from "zod";
import {
  oneFetchProfileV1Schema,
  oneFetchConsentV1Schema,
} from "./one-fetch.js";
const timestampSchema = z.string().datetime({ offset: true });
const durationSchema = z.number().finite().nonnegative();

export const remoteExecutionContextV1Schema = z
  .object({
    profile: oneFetchProfileV1Schema,
    token: z.string().min(1).max(16_384),
    consent: oneFetchConsentV1Schema,
  })
  .strict();
export type RemoteExecutionContextV1 = z.infer<
  typeof remoteExecutionContextV1Schema
>;

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

export const EXECUTION_PROTOCOL_VERSION = 1 as const;

export const executionStateV1Schema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "orphaned",
]);
export type ExecutionStateV1 = z.infer<typeof executionStateV1Schema>;

export const resultRetentionV1Schema = z.enum([
  "10m",
  "1h",
  "session",
  "manual",
]);
export type ResultRetentionV1 = z.infer<typeof resultRetentionV1Schema>;

export const executionErrorV1Schema = z
  .object({
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(4_096),
  })
  .strict();
export type ExecutionErrorV1 = z.infer<typeof executionErrorV1Schema>;

export const executionSummaryV1Schema = z
  .object({
    schemaVersion: z.literal(EXECUTION_PROTOCOL_VERSION),
    executionId: z.string().min(1),
    requestId: z.string().min(1),
    executor: executorV1Schema,
    state: executionStateV1Schema,
    retention: resultRetentionV1Schema,
    revision: z.number().int().nonnegative(),
    progress: executionProgressV1Schema,
    responseHandle: z.string().min(1).optional(),
    error: executionErrorV1Schema.optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    expiresAt: timestampSchema.optional(),
  })
  .strict();
export type ExecutionSummaryV1 = z.infer<typeof executionSummaryV1Schema>;

const executionMessageBase = {
  protocolVersion: z.literal(EXECUTION_PROTOCOL_VERSION),
  commandId: z.string().min(1),
};

export const startExecutionMessageSchema = z
  .object({
    ...executionMessageBase,
    type: z.literal("execution.start"),
    executionId: z.string().min(1),
    payloadHandle: z.string().min(1),
    remoteContext: remoteExecutionContextV1Schema.optional(),
  })
  .strict();
export type StartExecutionMessage = z.infer<typeof startExecutionMessageSchema>;

export const cancelExecutionMessageSchema = z
  .object({
    ...executionMessageBase,
    type: z.literal("execution.cancel"),
    executionId: z.string().min(1),
  })
  .strict();
export type CancelExecutionMessage = z.infer<
  typeof cancelExecutionMessageSchema
>;

export const subscribeExecutionsMessageSchema = z
  .object({
    ...executionMessageBase,
    type: z.literal("execution.subscribe"),
  })
  .strict();
export type SubscribeExecutionsMessage = z.infer<
  typeof subscribeExecutionsMessageSchema
>;

export const clearExecutionResultsMessageSchema = z
  .object({
    ...executionMessageBase,
    type: z.literal("execution.clear"),
    executionIds: z.array(z.string().min(1)).max(1_000).optional(),
    expiredOnly: z.boolean().optional(),
  })
  .strict();
export type ClearExecutionResultsMessage = z.infer<
  typeof clearExecutionResultsMessageSchema
>;

export const executionCommandV1Schema = z.discriminatedUnion("type", [
  startExecutionMessageSchema,
  cancelExecutionMessageSchema,
  subscribeExecutionsMessageSchema,
  clearExecutionResultsMessageSchema,
]);
export type ExecutionCommandV1 = z.infer<typeof executionCommandV1Schema>;

const executionEventBase = {
  protocolVersion: z.literal(EXECUTION_PROTOCOL_VERSION),
  eventId: z.string().min(1),
};

export const executionSnapshotMessageSchema = z
  .object({
    ...executionEventBase,
    type: z.literal("execution.snapshot"),
    executions: z.array(executionSummaryV1Schema),
  })
  .strict();
export type ExecutionSnapshotMessage = z.infer<
  typeof executionSnapshotMessageSchema
>;

export const executionProgressMessageSchema = z
  .object({
    ...executionEventBase,
    type: z.literal("execution.progress"),
    execution: executionSummaryV1Schema,
  })
  .strict();
export type ExecutionProgressMessage = z.infer<
  typeof executionProgressMessageSchema
>;

export const executionCompletedMessageSchema = z
  .object({
    ...executionEventBase,
    type: z.literal("execution.completed"),
    execution: executionSummaryV1Schema.extend({
      state: z.literal("succeeded"),
      responseHandle: z.string().min(1),
    }),
  })
  .strict();
export type ExecutionCompletedMessage = z.infer<
  typeof executionCompletedMessageSchema
>;

export const executionFailedMessageSchema = z
  .object({
    ...executionEventBase,
    type: z.literal("execution.failed"),
    execution: executionSummaryV1Schema.extend({
      state: z.enum(["failed", "cancelled", "orphaned"]),
      error: executionErrorV1Schema,
    }),
  })
  .strict();
export type ExecutionFailedMessage = z.infer<
  typeof executionFailedMessageSchema
>;

export const executionEventV1Schema = z.discriminatedUnion("type", [
  executionSnapshotMessageSchema,
  executionProgressMessageSchema,
  executionCompletedMessageSchema,
  executionFailedMessageSchema,
]);
export type ExecutionEventV1 = z.infer<typeof executionEventV1Schema>;

export const executionCommandResultV1Schema = z
  .object({
    protocolVersion: z.literal(EXECUTION_PROTOCOL_VERSION),
    commandId: z.string().min(1),
    accepted: z.boolean(),
    error: executionErrorV1Schema.optional(),
  })
  .strict()
  .refine((value) => value.accepted || value.error !== undefined, {
    message: "Rejected commands require an error",
  });
export type ExecutionCommandResultV1 = z.infer<
  typeof executionCommandResultV1Schema
>;

export const ExecutorV1Schema = executorV1Schema;
export const ExecutionProgressV1Schema = executionProgressV1Schema;
export const ExecutionStateV1Schema = executionStateV1Schema;
export const ResultRetentionV1Schema = resultRetentionV1Schema;
export const ExecutionSummaryV1Schema = executionSummaryV1Schema;
export const ExecutionCommandV1Schema = executionCommandV1Schema;
export const ExecutionEventV1Schema = executionEventV1Schema;
export const ExecutionCommandResultV1Schema = executionCommandResultV1Schema;
export const RemoteExecutionContextV1Schema = remoteExecutionContextV1Schema;
