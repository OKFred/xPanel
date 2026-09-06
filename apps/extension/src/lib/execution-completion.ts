import {
  executionSummaryV1Schema,
  type ExecutionSummaryV1,
} from "@xpanel/contracts";

import { database } from "./database";
import {
  createStoredResponseRecordsFromBlob,
  type ResponseMetadataV1,
  type StoredBodyDescriptor,
} from "./execution-response-store";
import { isTerminalExecution } from "./execution-repository";
import {
  executionPayloadRecordSchema,
  storedExecutionRecordSchema,
  type StoredResponseMetadata,
} from "./execution-storage";

export interface CompleteStreamedExecutionInput {
  executionId: string;
  payloadHandle: string;
  response: ResponseMetadataV1;
  body: StoredBodyDescriptor;
  blob: Blob;
  prettyBlob?: Blob;
  presentation?: StoredResponseMetadata["presentation"];
}

function expiration(retention: ExecutionSummaryV1["retention"], now: number) {
  if (retention === "10m") return new Date(now + 10 * 60_000).toISOString();
  if (retention === "1h") return new Date(now + 60 * 60_000).toISOString();
  return undefined;
}

export async function completeStreamedExecution(
  input: CompleteStreamedExecutionInput,
): Promise<ExecutionSummaryV1> {
  const db = await database();
  const transaction = db.transaction(
    [
      "executions",
      "execution-payloads",
      "execution-files",
      "execution-responses",
      "execution-bodies",
    ],
    "readwrite",
  );
  const executionStore = transaction.objectStore("executions");
  const currentValue = await executionStore.get(input.executionId);
  if (!currentValue) {
    throw new Error(`Execution ${input.executionId} was not found.`);
  }
  const current = storedExecutionRecordSchema.parse(currentValue);
  if (isTerminalExecution(current.summary)) {
    await transaction.done;
    return current.summary;
  }
  const payloadStore = transaction.objectStore("execution-payloads");
  const requestedPayload = await payloadStore.get(input.payloadHandle);
  const ownedPayload =
    requestedPayload?.executionId === input.executionId
      ? executionPayloadRecordSchema.parse(requestedPayload)
      : await payloadStore.index("by-execution").get(input.executionId);
  if (!ownedPayload) {
    throw new Error(`Execution ${input.executionId} has no staged payload.`);
  }
  const validatedPayload = executionPayloadRecordSchema.parse(ownedPayload);

  const completedAt = Date.now();
  const updatedAt = new Date(completedAt).toISOString();
  const expiresAt = expiration(current.summary.retention, completedAt);
  const responseHandle = crypto.randomUUID();
  const records = createStoredResponseRecordsFromBlob({
    executionId: input.executionId,
    responseHandle,
    response: input.response,
    body: input.body,
    blob: input.blob,
    ...(input.prettyBlob ? { prettyBlob: input.prettyBlob } : {}),
    ...(input.presentation ? { presentation: input.presentation } : {}),
    createdAt: updatedAt,
    ...(expiresAt ? { expiresAt } : {}),
  });
  const summary = executionSummaryV1Schema.parse({
    ...current.summary,
    state: "succeeded",
    revision: current.summary.revision + 1,
    progress: {
      phase: "complete",
      loadedBytes: input.body.sizeBytes,
      totalBytes: input.body.sizeBytes,
      elapsedMs: input.response.timings.durationMs,
    },
    responseHandle,
    updatedAt,
    ...(expiresAt ? { expiresAt } : {}),
  });

  const fileStore = transaction.objectStore("execution-files");
  const fileKeys = await fileStore
    .index("by-payload")
    .getAllKeys(validatedPayload.handle);
  await Promise.all([
    executionStore.put({ ...current, summary }),
    transaction.objectStore("execution-responses").put(records.metadata),
    transaction.objectStore("execution-bodies").put(records.body),
    payloadStore.delete(validatedPayload.handle),
    ...fileKeys.map((key) => fileStore.delete(key)),
  ]);
  await transaction.done;
  return summary;
}
