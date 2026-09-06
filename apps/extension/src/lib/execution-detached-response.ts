import {
  executionSummaryV1Schema,
  responseRecordV1Schema,
  resultRetentionV1Schema,
  type ExecutionSummaryV1,
  type ResponseRecordV1,
  type ResultRetentionV1,
} from "@xpanel/contracts";

import { database } from "./database";
import { createStoredResponseRecords } from "./execution-response-store";
import { MAX_RESPONSE_LIMIT_BYTES } from "./execution-storage";

function expiration(retention: ResultRetentionV1, now: number) {
  if (retention === "10m") return new Date(now + 10 * 60_000).toISOString();
  if (retention === "1h") return new Date(now + 60 * 60_000).toISOString();
  return undefined;
}

export async function storeDetachedExecutionResponse(
  responseInput: ResponseRecordV1,
  retentionInput: ResultRetentionV1,
  sessionId: string,
): Promise<ExecutionSummaryV1> {
  const response = responseRecordV1Schema.parse(responseInput);
  const retention = resultRetentionV1Schema.parse(retentionInput);
  if (response.body.sizeBytes > MAX_RESPONSE_LIMIT_BYTES) {
    throw new Error("Imported response exceeds the 100 MiB local limit.");
  }
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = expiration(retention, now);
  const executionId = crypto.randomUUID();
  const responseHandle = crypto.randomUUID();
  const summary = executionSummaryV1Schema.parse({
    schemaVersion: 1,
    executionId,
    requestId: response.requestId,
    executor: response.executor,
    state: "succeeded",
    retention,
    revision: 0,
    progress: {
      phase: "complete",
      loadedBytes: response.body.sizeBytes,
      totalBytes: response.body.sizeBytes,
      elapsedMs: response.timings.durationMs,
    },
    responseHandle,
    createdAt,
    updatedAt: createdAt,
    ...(expiresAt ? { expiresAt } : {}),
  });
  const records = createStoredResponseRecords({
    executionId,
    responseHandle,
    response,
    createdAt,
    ...(expiresAt ? { expiresAt } : {}),
  });
  const db = await database();
  const transaction = db.transaction(
    ["executions", "execution-responses", "execution-bodies"],
    "readwrite",
  );
  await Promise.all([
    transaction.objectStore("executions").add({ summary, sessionId }),
    transaction.objectStore("execution-responses").add(records.metadata),
    transaction.objectStore("execution-bodies").add(records.body),
    transaction.done,
  ]);
  return summary;
}
