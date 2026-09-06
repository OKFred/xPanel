import { z } from "zod";

import {
  EXECUTION_PROTOCOL_VERSION,
  cancelExecutionMessageSchema,
  executionCommandV1Schema,
  executionEventV1Schema,
  startExecutionMessageSchema,
  type ExecutionCommandV1,
  type ExecutionEventV1,
} from "@xpanel/contracts";

const channel = z.literal("xpanel.execution.v1");

export const executionControlEnvelopeSchema = z
  .object({
    channel,
    recipient: z.literal("background"),
    command: executionCommandV1Schema,
  })
  .strict();
export type ExecutionControlEnvelope = z.infer<
  typeof executionControlEnvelopeSchema
>;

export const executionDispatchEnvelopeSchema = z
  .object({
    channel,
    recipient: z.literal("offscreen"),
    command: z.union([
      startExecutionMessageSchema,
      cancelExecutionMessageSchema,
    ]),
  })
  .strict();
export type ExecutionDispatchEnvelope = z.infer<
  typeof executionDispatchEnvelopeSchema
>;

export const executionEventEnvelopeSchema = z
  .object({
    channel,
    recipient: z.literal("clients"),
    event: executionEventV1Schema,
  })
  .strict();
export type ExecutionEventEnvelope = z.infer<
  typeof executionEventEnvelopeSchema
>;

export function controlEnvelope(
  command: ExecutionCommandV1,
): ExecutionControlEnvelope {
  return executionControlEnvelopeSchema.parse({
    channel: "xpanel.execution.v1",
    recipient: "background",
    command,
  });
}

export function dispatchEnvelope(
  command: Extract<
    ExecutionCommandV1,
    { type: "execution.start" | "execution.cancel" }
  >,
): ExecutionDispatchEnvelope {
  return executionDispatchEnvelopeSchema.parse({
    channel: "xpanel.execution.v1",
    recipient: "offscreen",
    command,
  });
}

export function eventEnvelope(event: ExecutionEventV1): ExecutionEventEnvelope {
  return executionEventEnvelopeSchema.parse({
    channel: "xpanel.execution.v1",
    recipient: "clients",
    event,
  });
}

export function protocolVersion(): typeof EXECUTION_PROTOCOL_VERSION {
  return EXECUTION_PROTOCOL_VERSION;
}
