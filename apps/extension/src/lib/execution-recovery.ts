import type { ExecutionSummaryV1 } from "@xpanel/contracts";

import { database } from "./database";
import {
  clearExecutionResults,
  failExecution,
  findExecutionPayload,
  listExecutionSummaries,
} from "./execution-repository";
import { storedExecutionRecordSchema } from "./execution-storage";

export const QUEUED_DISPATCH_TIMEOUT_MS = 2 * 60_000;

export async function cleanupPreviousSessions(
  sessionId: string,
): Promise<ExecutionSummaryV1[]> {
  const db = await database();
  const records = await db.getAll("executions");
  const affected = records.flatMap((value) => {
    const record = storedExecutionRecordSchema.parse(value);
    return record.sessionId !== sessionId &&
      record.summary.retention === "session" &&
      record.summary.state !== "queued" &&
      record.summary.state !== "running"
      ? [record.summary]
      : [];
  });
  await clearExecutionResults({
    executionIds: affected.map((summary) => summary.executionId),
  });
  return affected;
}

async function orphan(
  summaries: readonly ExecutionSummaryV1[],
  replacementSessionId?: string,
): Promise<ExecutionSummaryV1[]> {
  const results: ExecutionSummaryV1[] = [];
  for (const summary of summaries) {
    const payload = await findExecutionPayload(summary.executionId);
    results.push(
      await failExecution(
        summary.executionId,
        payload?.handle,
        "orphaned",
        {
          code: "orphaned",
          message: "The execution context ended before the request completed.",
        },
        replacementSessionId,
      ),
    );
  }
  return results;
}

export async function markPreviousSessionExecutionsOrphaned(
  sessionId: string,
): Promise<ExecutionSummaryV1[]> {
  const db = await database();
  const records = await db.getAll("executions");
  const activeFromPreviousSessions = records.flatMap((value) => {
    const record = storedExecutionRecordSchema.parse(value);
    return record.sessionId !== sessionId &&
      (record.summary.state === "queued" || record.summary.state === "running")
      ? [record.summary]
      : [];
  });
  return orphan(activeFromPreviousSessions, sessionId);
}

export async function markRunningExecutionsOrphaned(): Promise<
  ExecutionSummaryV1[]
> {
  const running = (await listExecutionSummaries()).filter(
    (summary) => summary.state === "running",
  );
  return orphan(running);
}

export async function markStaleQueuedExecutionsOrphaned(
  now = Date.now(),
): Promise<ExecutionSummaryV1[]> {
  const staleBefore = now - QUEUED_DISPATCH_TIMEOUT_MS;
  const queued = (await listExecutionSummaries()).filter(
    (summary) =>
      summary.state === "queued" &&
      Date.parse(summary.createdAt) <= staleBefore,
  );
  return orphan(queued);
}
