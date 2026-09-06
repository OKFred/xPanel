import { z } from "zod";

import {
  executionSummaryV1Schema,
  responseRecordV1Schema,
} from "@xpanel/contracts";

import {
  MAX_RESPONSE_LIMIT_BYTES,
  MIN_RESPONSE_LIMIT_BYTES,
} from "./execution-storage";

export const responseMetadataV1Schema = responseRecordV1Schema.omit({
  body: true,
});

export const processorBeginSchema = z
  .object({
    type: z.literal("processor.begin"),
    jobId: z.string().min(1),
    executionId: z.string().min(1),
    payloadHandle: z.string().min(1),
    response: responseMetadataV1Schema,
    encoding: z.enum(["utf8", "base64"]),
    mediaType: z.string().min(1).optional(),
    maximumBytes: z
      .number()
      .int()
      .min(MIN_RESPONSE_LIMIT_BYTES)
      .max(MAX_RESPONSE_LIMIT_BYTES),
  })
  .strict();

export const processorChunkSchema = z
  .object({
    type: z.literal("processor.chunk"),
    jobId: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    chunk: z.instanceof(ArrayBuffer),
  })
  .strict();

export const processorFinishSchema = z
  .object({
    type: z.literal("processor.finish"),
    jobId: z.string().min(1),
    durationMs: z.number().finite().nonnegative(),
  })
  .strict();

export const processorCancelSchema = z
  .object({
    type: z.literal("processor.cancel"),
    jobId: z.string().min(1),
  })
  .strict();

export const processorInputSchema = z.discriminatedUnion("type", [
  processorBeginSchema,
  processorChunkSchema,
  processorFinishSchema,
  processorCancelSchema,
]);
export type ProcessorInput = z.infer<typeof processorInputSchema>;

export const processorOutputSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("processor.ready"),
      jobId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("processor.chunk-ack"),
      jobId: z.string().min(1),
      sequence: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal("processor.complete"),
      jobId: z.string().min(1),
      execution: executionSummaryV1Schema,
    })
    .strict(),
  z
    .object({
      type: z.literal("processor.cancelled"),
      jobId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("processor.error"),
      jobId: z.string().min(1),
      error: z
        .object({
          code: z.string().min(1).max(128),
          message: z.string().min(1).max(4_096),
        })
        .strict(),
    })
    .strict(),
]);
export type ProcessorOutput = z.infer<typeof processorOutputSchema>;
