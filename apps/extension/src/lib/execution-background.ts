import {
  EXECUTION_PROTOCOL_VERSION,
  executionCommandResultV1Schema,
  type ExecutionCommandResultV1,
  type ExecutionCommandV1,
  type ExecutionEventV1,
  type ExecutionSummaryV1,
} from "@xpanel/contracts";

import {
  clearExecutionResults,
  failExecution,
  findExecutionPayload,
  listExecutionSummaries,
} from "./execution-repository";
import {
  cleanupPreviousSessions,
  markPreviousSessionExecutionsOrphaned,
  markRunningExecutionsOrphaned,
  markStaleQueuedExecutionsOrphaned,
} from "./execution-recovery";
import {
  dispatchEnvelope,
  eventEnvelope,
  executionControlEnvelopeSchema,
} from "./execution-messages";
import { executionSessionId } from "./execution-session";

const OFFSCREEN_PATH = "offscreen.html";
const CLEANUP_ALARM = "xpanel-execution-cleanup-v1";
export const MAX_CONCURRENT_EXECUTIONS = 4;

export function hasBackgroundExecutionCapacity(runningCount: number): boolean {
  return runningCount < MAX_CONCURRENT_EXECUTIONS;
}

let offscreenCreation: Promise<void> | undefined;
let commandQueue = Promise.resolve();

function commandResult(
  commandId: string,
  accepted: boolean,
  error?: { code: string; message: string },
): ExecutionCommandResultV1 {
  return executionCommandResultV1Schema.parse({
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    commandId,
    accepted,
    ...(error ? { error } : {}),
  });
}

function errorDetails(error: unknown): { code: string; message: string } {
  return {
    code: "background_error",
    message:
      error instanceof Error ? error.message : "Background command failed.",
  };
}

async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) return;
  offscreenCreation ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.BLOBS],
      justification:
        "Run user-started HTTP requests and store streamed response blobs after the workbench closes.",
    })
    .finally(() => {
      offscreenCreation = undefined;
    });
  await offscreenCreation;
}

async function broadcast(event: ExecutionEventV1): Promise<void> {
  try {
    await chrome.runtime.sendMessage(eventEnvelope(event));
  } catch {
    // A persisted snapshot remains available when no workbench is listening.
  }
}

function snapshotEvent(executions: ExecutionSummaryV1[]): ExecutionEventV1 {
  return {
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    eventId: crypto.randomUUID(),
    type: "execution.snapshot",
    executions,
  };
}

async function rejectExecution(
  command: Extract<ExecutionCommandV1, { type: "execution.start" }>,
  code: string,
  message: string,
): Promise<ExecutionCommandResultV1> {
  const summary = await failExecution(
    command.executionId,
    command.payloadHandle,
    "failed",
    { code, message },
  );
  await broadcast({
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    eventId: crypto.randomUUID(),
    type: "execution.failed",
    execution: { ...summary, state: "failed", error: { code, message } },
  });
  return commandResult(command.commandId, false, { code, message });
}

async function startCommand(
  command: Extract<ExecutionCommandV1, { type: "execution.start" }>,
): Promise<ExecutionCommandResultV1> {
  const payload = await findExecutionPayload(command.executionId);
  if (!payload || payload.handle !== command.payloadHandle) {
    return rejectExecution(
      command,
      "invalid_payload",
      "The staged execution payload is missing or mismatched.",
    );
  }
  const runningCount = (await listExecutionSummaries()).filter(
    (summary) => summary.state === "running",
  ).length;
  if (!hasBackgroundExecutionCapacity(runningCount)) {
    return rejectExecution(
      command,
      "concurrency_limit",
      `xPanel allows at most ${MAX_CONCURRENT_EXECUTIONS} background executions.`,
    );
  }
  await ensureOffscreenDocument();
  const rawResult: unknown = await chrome.runtime.sendMessage(
    dispatchEnvelope(command),
  );
  return executionCommandResultV1Schema.parse(rawResult);
}

async function cancelCommand(
  command: Extract<ExecutionCommandV1, { type: "execution.cancel" }>,
): Promise<ExecutionCommandResultV1> {
  if (!(await hasOffscreenDocument())) {
    const payload = await findExecutionPayload(command.executionId);
    if (payload) {
      const cancelled = await failExecution(
        command.executionId,
        payload.handle,
        "cancelled",
        { code: "cancelled", message: "Request cancelled." },
      );
      await broadcast(eventForFailed(cancelled));
    }
    return payload
      ? commandResult(command.commandId, true)
      : commandResult(command.commandId, false, {
          code: "not_running",
          message: "The execution context is no longer running.",
        });
  }
  const rawResult: unknown = await chrome.runtime.sendMessage(
    dispatchEnvelope(command),
  );
  return executionCommandResultV1Schema.parse(rawResult);
}

function eventForFailed(summary: ExecutionSummaryV1): ExecutionEventV1 {
  const error = summary.error ?? {
    code: "execution_failed",
    message: "Execution failed.",
  };
  return {
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    eventId: crypto.randomUUID(),
    type: "execution.failed",
    execution: {
      ...summary,
      state:
        summary.state === "cancelled" || summary.state === "orphaned"
          ? summary.state
          : "failed",
      error,
    },
  };
}

async function handleCommand(
  command: ExecutionCommandV1,
): Promise<ExecutionCommandResultV1> {
  try {
    if (command.type === "execution.start") return await startCommand(command);
    if (command.type === "execution.cancel")
      return await cancelCommand(command);
    if (command.type === "execution.clear") {
      await clearExecutionResults({
        ...(command.executionIds ? { executionIds: command.executionIds } : {}),
        ...(command.expiredOnly === undefined
          ? {}
          : { expiredOnly: command.expiredOnly }),
      });
      await broadcast(snapshotEvent(await listExecutionSummaries()));
      return commandResult(command.commandId, true);
    }
    await broadcast(snapshotEvent(await listExecutionSummaries()));
    return commandResult(command.commandId, true);
  } catch (error) {
    const details = errorDetails(error);
    if (command.type === "execution.start") {
      try {
        return await rejectExecution(command, details.code, details.message);
      } catch {
        // Preserve the original, already-sanitized command error.
      }
    }
    return commandResult(command.commandId, false, details);
  }
}

async function initializeBackground(): Promise<void> {
  const sessionId = await executionSessionId();
  // Clear completed session-only data first. Active work from the previous
  // Chrome session is orphaned afterwards so the new session can surface the
  // failure instead of deleting it before a workbench has a chance to recover.
  await cleanupPreviousSessions(sessionId);
  const previousSessionOrphans =
    await markPreviousSessionExecutionsOrphaned(sessionId);
  for (const execution of previousSessionOrphans) {
    await broadcast(eventForFailed(execution));
  }
  for (const execution of await markStaleQueuedExecutionsOrphaned()) {
    await broadcast(eventForFailed(execution));
  }
  if (!(await hasOffscreenDocument())) {
    const orphaned = await markRunningExecutionsOrphaned();
    for (const execution of orphaned) {
      if (!execution.error) continue;
      await broadcast({
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        eventId: crypto.randomUUID(),
        type: "execution.failed",
        execution: {
          ...execution,
          state: "orphaned",
          error: execution.error,
        },
      });
    }
  }
  await chrome.alarms.create(CLEANUP_ALARM, { periodInMinutes: 1 });
}

async function cleanupAndRecoverExecutions(): Promise<void> {
  await clearExecutionResults({ expiredOnly: true });
  for (const execution of await markStaleQueuedExecutionsOrphaned()) {
    await broadcast(eventForFailed(execution));
  }
  if (await hasOffscreenDocument()) return;
  for (const execution of await markRunningExecutionsOrphaned()) {
    await broadcast(eventForFailed(execution));
  }
}

export function startExecutionBackground(): void {
  const initialized = initializeBackground();
  void initialized.catch(() => undefined);
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    const parsed = executionControlEnvelopeSchema.safeParse(message);
    if (!parsed.success) return false;
    commandQueue = commandQueue
      .then(async () => {
        await initialized;
        return handleCommand(parsed.data.command);
      })
      .then(sendResponse, (error: unknown) => {
        sendResponse(
          commandResult(
            parsed.data.command.commandId,
            false,
            errorDetails(error),
          ),
        );
      });
    return true;
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== CLEANUP_ALARM) return;
    void cleanupAndRecoverExecutions().catch(() => undefined);
  });
}
