import {
  executionSummaryV1Schema,
  type ExecutionErrorV1,
  type ExecutionProgressV1,
  type ExecutionStateV1,
  type ExecutionSummaryV1,
  type ResponseRecordV1,
  type ResultRetentionV1,
} from "@xpanel/contracts";

import { database } from "./database";
import { createStoredResponseRecords } from "./execution-response-store";
import {
  executionPayloadRecordSchema,
  isStoredBlob,
  stageExecutionInputSchema,
  storedExecutionRecordSchema,
  type ExecutionFileRecord,
  type ExecutionPayloadRecord,
  type StageExecutionInput,
  type StagedExecution,
} from "./execution-storage";

const ACTIVE_STATES = new Set<ExecutionStateV1>(["queued", "running"]);
const TERMINAL_STATES = new Set<ExecutionStateV1>([
  "succeeded",
  "failed",
  "cancelled",
  "orphaned",
]);

export interface StagedFileInput {
  referenceId: string;
  file: File;
}

function timestamp(now = Date.now()): string {
  return new Date(now).toISOString();
}

function expiresAt(
  retention: ResultRetentionV1,
  completedAt: number,
): string | undefined {
  if (retention === "10m") return timestamp(completedAt + 10 * 60_000);
  if (retention === "1h") return timestamp(completedAt + 60 * 60_000);
  return undefined;
}

function initialProgress(): ExecutionProgressV1 {
  return {
    phase: "preparing",
    loadedBytes: 0,
    elapsedMs: 0,
  };
}

function executionFileRecord(
  payloadHandle: string,
  input: StagedFileInput,
): ExecutionFileRecord {
  return {
    key: `${payloadHandle}\0${input.referenceId}`,
    payloadHandle,
    referenceId: input.referenceId,
    name: input.file.name,
    mediaType: input.file.type,
    lastModified: input.file.lastModified,
    blob: input.file,
  };
}

export async function stageExecution(
  input: StageExecutionInput,
  sessionId: string,
  files: readonly StagedFileInput[] = [],
): Promise<StagedExecution> {
  const validated = stageExecutionInputSchema.parse(input);
  const executionId = crypto.randomUUID();
  const payloadHandle = crypto.randomUUID();
  const createdAt = timestamp();
  const summary = executionSummaryV1Schema.parse({
    schemaVersion: 1,
    executionId,
    requestId: validated.request.id,
    executor: validated.target.kind,
    state: "queued",
    retention: validated.retention,
    revision: 0,
    progress: initialProgress(),
    createdAt,
    updatedAt: createdAt,
  });
  const payload = executionPayloadRecordSchema.parse({
    schemaVersion: 1,
    handle: payloadHandle,
    executionId,
    request: validated.request,
    target: validated.target,
    responseLimitBytes: validated.responseLimitBytes,
    createdAt,
  });
  const fileRecords = files.map((file) =>
    executionFileRecord(payloadHandle, file),
  );
  const uniqueReferences = new Set(fileRecords.map((file) => file.referenceId));
  if (uniqueReferences.size !== fileRecords.length) {
    throw new Error("Each staged file reference must be unique.");
  }

  const db = await database();
  const transaction = db.transaction(
    ["executions", "execution-payloads", "execution-files"],
    "readwrite",
  );
  await Promise.all([
    transaction.objectStore("executions").add({ summary, sessionId }),
    transaction.objectStore("execution-payloads").add(payload),
    ...fileRecords.map((file) =>
      transaction.objectStore("execution-files").add(file),
    ),
    transaction.done,
  ]);
  return { summary, payloadHandle };
}

export async function loadExecutionPayload(
  payloadHandle: string,
): Promise<ExecutionPayloadRecord | undefined> {
  const db = await database();
  const value = await db.get("execution-payloads", payloadHandle);
  if (value === undefined) return undefined;
  return executionPayloadRecordSchema.parse(value);
}

export async function findExecutionPayload(
  executionId: string,
): Promise<ExecutionPayloadRecord | undefined> {
  const db = await database();
  const value = await db.getFromIndex(
    "execution-payloads",
    "by-execution",
    executionId,
  );
  return value ? executionPayloadRecordSchema.parse(value) : undefined;
}

export async function loadExecutionFiles(
  payloadHandle: string,
): Promise<ExecutionFileRecord[]> {
  const db = await database();
  const files = await db.getAllFromIndex(
    "execution-files",
    "by-payload",
    payloadHandle,
  );
  for (const file of files) {
    if (!isStoredBlob(file.blob)) {
      throw new Error(`Stored file ${file.referenceId} is invalid.`);
    }
  }
  return files;
}

export async function listExecutionSummaries(): Promise<ExecutionSummaryV1[]> {
  const db = await database();
  const records = await db.getAll("executions");
  return records
    .flatMap((record) => {
      const parsed = storedExecutionRecordSchema.safeParse(record);
      return parsed.success ? [parsed.data.summary] : [];
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function countActiveExecutions(): Promise<number> {
  const summaries = await listExecutionSummaries();
  return summaries.filter((summary) => ACTIVE_STATES.has(summary.state)).length;
}

async function mutateSummary(
  executionId: string,
  mutate: (summary: ExecutionSummaryV1) => ExecutionSummaryV1,
): Promise<ExecutionSummaryV1> {
  const db = await database();
  const transaction = db.transaction("executions", "readwrite");
  const store = transaction.objectStore("executions");
  const current = await store.get(executionId);
  if (!current) throw new Error(`Execution ${executionId} was not found.`);
  const record = storedExecutionRecordSchema.parse(current);
  const summary = executionSummaryV1Schema.parse(mutate(record.summary));
  await store.put({ ...record, summary });
  await transaction.done;
  return summary;
}

export function isTerminalExecution(summary: ExecutionSummaryV1): boolean {
  return TERMINAL_STATES.has(summary.state);
}

export async function markExecutionRunning(
  executionId: string,
): Promise<ExecutionSummaryV1> {
  return mutateSummary(executionId, (current) => {
    if (isTerminalExecution(current)) return current;
    const updatedAt = timestamp();
    return {
      ...current,
      state: "running",
      revision: current.revision + 1,
      updatedAt,
    };
  });
}

export async function updateExecutionProgress(
  executionId: string,
  progress: ExecutionProgressV1,
): Promise<ExecutionSummaryV1> {
  return mutateSummary(executionId, (current) => {
    if (isTerminalExecution(current)) return current;
    return {
      ...current,
      state: "running",
      revision: current.revision + 1,
      progress,
      updatedAt: timestamp(),
    };
  });
}

export async function completeExecution(
  executionId: string,
  payloadHandle: string,
  response: ResponseRecordV1,
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
  const currentValue = await executionStore.get(executionId);
  if (!currentValue) throw new Error(`Execution ${executionId} was not found.`);
  const current = storedExecutionRecordSchema.parse(currentValue);
  if (isTerminalExecution(current.summary)) {
    await transaction.done;
    return current.summary;
  }
  const payloadStore = transaction.objectStore("execution-payloads");
  const requestedPayload = await payloadStore.get(payloadHandle);
  const ownedPayload =
    requestedPayload?.executionId === executionId
      ? executionPayloadRecordSchema.parse(requestedPayload)
      : await payloadStore.index("by-execution").get(executionId);
  if (!ownedPayload) {
    throw new Error(`Execution ${executionId} has no staged payload.`);
  }
  const validatedPayload = executionPayloadRecordSchema.parse(ownedPayload);
  const completedAt = Date.now();
  const expiration = expiresAt(current.summary.retention, completedAt);
  const responseHandle = crypto.randomUUID();
  const records = createStoredResponseRecords({
    executionId,
    responseHandle,
    response,
    createdAt: timestamp(),
    ...(expiration ? { expiresAt: expiration } : {}),
  });
  const summary = executionSummaryV1Schema.parse({
    ...current.summary,
    state: "succeeded",
    revision: current.summary.revision + 1,
    progress: {
      phase: "complete",
      loadedBytes: response.body.sizeBytes,
      totalBytes: response.body.sizeBytes,
      elapsedMs: response.timings.durationMs,
    },
    responseHandle,
    updatedAt: timestamp(completedAt),
    ...(expiration ? { expiresAt: expiration } : {}),
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

export async function failExecution(
  executionId: string,
  payloadHandle: string | undefined,
  state: Extract<ExecutionStateV1, "failed" | "cancelled" | "orphaned">,
  error: ExecutionErrorV1,
  replacementSessionId?: string,
): Promise<ExecutionSummaryV1> {
  const db = await database();
  const transaction = db.transaction(
    ["executions", "execution-payloads", "execution-files"],
    "readwrite",
  );
  const executionStore = transaction.objectStore("executions");
  const currentValue = await executionStore.get(executionId);
  if (!currentValue) throw new Error(`Execution ${executionId} was not found.`);
  const current = storedExecutionRecordSchema.parse(currentValue);
  if (isTerminalExecution(current.summary)) {
    await transaction.done;
    return current.summary;
  }
  const completedAt = Date.now();
  const expiration = expiresAt(current.summary.retention, completedAt);
  const summary = executionSummaryV1Schema.parse({
    ...current.summary,
    state,
    revision: current.summary.revision + 1,
    error,
    updatedAt: timestamp(completedAt),
    ...(expiration ? { expiresAt: expiration } : {}),
  });
  await executionStore.put({
    ...current,
    ...(replacementSessionId ? { sessionId: replacementSessionId } : {}),
    summary,
  });
  const payloadStore = transaction.objectStore("execution-payloads");
  const requestedPayload = payloadHandle
    ? await payloadStore.get(payloadHandle)
    : undefined;
  const ownedPayload =
    requestedPayload?.executionId === executionId
      ? executionPayloadRecordSchema.parse(requestedPayload)
      : await payloadStore.index("by-execution").get(executionId);
  if (ownedPayload) {
    const validatedPayload = executionPayloadRecordSchema.parse(ownedPayload);
    const fileStore = transaction.objectStore("execution-files");
    const fileKeys = await fileStore
      .index("by-payload")
      .getAllKeys(validatedPayload.handle);
    await Promise.all([
      payloadStore.delete(validatedPayload.handle),
      ...fileKeys.map((key) => fileStore.delete(key)),
    ]);
  }
  await transaction.done;
  return summary;
}

async function deleteExecutions(
  executionIds: readonly string[],
): Promise<void> {
  if (executionIds.length === 0) return;
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
  for (const executionId of executionIds) {
    const record = await transaction.objectStore("executions").get(executionId);
    if (!record || ACTIVE_STATES.has(record.summary.state)) continue;
    const payload = await transaction
      .objectStore("execution-payloads")
      .index("by-execution")
      .get(executionId);
    const response = await transaction
      .objectStore("execution-responses")
      .index("by-execution")
      .get(executionId);
    if (payload) {
      const fileStore = transaction.objectStore("execution-files");
      const fileKeys = await fileStore
        .index("by-payload")
        .getAllKeys(payload.handle);
      await Promise.all([
        transaction.objectStore("execution-payloads").delete(payload.handle),
        ...fileKeys.map((key) => fileStore.delete(key)),
      ]);
    }
    if (response) {
      await Promise.all([
        transaction.objectStore("execution-responses").delete(response.handle),
        transaction.objectStore("execution-bodies").delete(response.handle),
      ]);
    }
    await transaction.objectStore("executions").delete(executionId);
  }
  await transaction.done;
}

export async function clearExecutionResults(
  options: {
    executionIds?: readonly string[];
    expiredOnly?: boolean;
    now?: number;
  } = {},
): Promise<void> {
  const summaries = await listExecutionSummaries();
  const requested = options.executionIds
    ? new Set(options.executionIds)
    : undefined;
  const now = options.now ?? Date.now();
  const executionIds = summaries
    .filter((summary) => !requested || requested.has(summary.executionId))
    .filter(
      (summary) =>
        !options.expiredOnly ||
        (summary.expiresAt !== undefined &&
          Date.parse(summary.expiresAt) <= now),
    )
    .map((summary) => summary.executionId);
  await deleteExecutions(executionIds);
}
