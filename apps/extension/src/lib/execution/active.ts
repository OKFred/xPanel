import {
  executionProgressV1Schema,
  type ExecutionProgressV1,
} from "@xpanel/contracts";

import type { ExecuteOptionsV1 } from "./types";

export interface ActiveExecution {
  requestId: string;
  controller: AbortController;
  onProgress?: (progress: ExecutionProgressV1) => void;
  startedAt: number;
  cancelling: boolean;
  lastProgress?: ExecutionProgressV1;
  timeoutHandle: number;
}

const activeRequests = new Map<string, ActiveExecution>();

export function beginExecution(
  requestId: string,
  timeoutMs: number,
  options: ExecuteOptionsV1,
): ActiveExecution {
  if (activeRequests.has(requestId)) {
    throw new Error("This request is already running.");
  }
  const execution: ActiveExecution = {
    requestId,
    controller: new AbortController(),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    startedAt: performance.now(),
    cancelling: false,
    timeoutHandle: 0,
  };
  activeRequests.set(requestId, execution);
  execution.timeoutHandle = window.setTimeout(
    () => execution.controller.abort("timeout"),
    timeoutMs,
  );
  return execution;
}

export function finishExecution(execution: ActiveExecution): void {
  window.clearTimeout(execution.timeoutHandle);
  if (activeRequests.get(execution.requestId) === execution) {
    activeRequests.delete(execution.requestId);
  }
}

export function reportProgress(
  execution: ActiveExecution,
  phase: ExecutionProgressV1["phase"],
  loadedBytes: number,
  totalBytes?: number,
): void {
  const progress = executionProgressV1Schema.parse({
    phase,
    loadedBytes,
    ...(totalBytes === undefined ? {} : { totalBytes }),
    elapsedMs: performance.now() - execution.startedAt,
  });
  execution.lastProgress = progress;
  try {
    execution.onProgress?.(progress);
  } catch {
    // Progress observers cannot fail request execution.
  }
}

export function normalizeExecutionError(
  execution: ActiveExecution,
  error: unknown,
): unknown {
  if (
    !execution.controller.signal.aborted ||
    execution.controller.signal.reason === "response-too-large"
  ) {
    return error;
  }
  const message =
    execution.controller.signal.reason === "timeout"
      ? "Request timed out."
      : "Request cancelled.";
  return new DOMException(message, "AbortError");
}

export function cancelRequest(requestId: string): boolean {
  const execution = activeRequests.get(requestId);
  if (!execution) return false;
  execution.cancelling = true;
  reportProgress(
    execution,
    "cancelling",
    execution.lastProgress?.loadedBytes ?? 0,
    execution.lastProgress?.totalBytes,
  );
  execution.controller.abort("cancelled");
  return true;
}

export function isRequestCancelling(requestId: string): boolean {
  return activeRequests.get(requestId)?.cancelling === true;
}
