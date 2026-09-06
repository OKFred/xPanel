import { computed, nextTick, ref, shallowRef, type Ref } from "vue";

import type {
  ExecutionEventV1,
  ExecutionProgressV1,
  ExecutionSummaryV1,
  ExecutionWarning,
  RequestSpecV1,
  ResponseRecordV1,
  ResultRetentionV1,
} from "@xpanel/contracts";

import {
  cancelBackgroundExecution,
  clearBackgroundExecutionResults,
  listExecutionSummaries,
  loadExecutionPreferences,
  loadExecutionPrettyBody,
  loadExecutionResponse,
  loadExecutionResponseBody,
  loadExecutionResponseMetadata,
  persistImportedResponse,
  saveExecutionPreferences,
  startBackgroundExecution,
  subscribeExecutionEvents,
  type BackgroundExecutionTarget,
  type StoredResponseMetadata,
} from "../lib/execution-client";

const MEBIBYTE = 1024 * 1024;

export interface ExecutionResponseView {
  metadata: StoredResponseMetadata;
  body: Blob;
  prettyBody?: Blob;
}

interface RunExecutionInput {
  request: RequestSpecV1;
  target: BackgroundExecutionTarget;
  notice?: string;
  warning?: ExecutionWarning;
}

interface UseExecutionWorkbenchOptions {
  busy: Ref<boolean>;
  notice: Ref<string>;
  errorMessage: Ref<string>;
  onResponseReady?: (response: StoredResponseMetadata) => void;
}

function isActive(summary: ExecutionSummaryV1): boolean {
  return summary.state === "queued" || summary.state === "running";
}

function mostRecent(
  summaries: Iterable<ExecutionSummaryV1>,
  predicate: (summary: ExecutionSummaryV1) => boolean,
): ExecutionSummaryV1 | undefined {
  return [...summaries]
    .filter(predicate)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

export function useExecutionWorkbench(options: UseExecutionWorkbenchOptions) {
  const activeExecutionId = ref("");
  const cancelling = ref(false);
  const executionProgress = ref<ExecutionProgressV1 | null>(null);
  const responseView = shallowRef<ExecutionResponseView | null>(null);
  const retention = ref<ResultRetentionV1>("10m");
  const responseLimitMiB = ref(20);
  const summaries = new Map<string, ExecutionSummaryV1>();
  const localWarnings = new Map<string, ExecutionWarning>();
  let pendingRequestId = "";
  let responseLoadRevision = 0;
  let unsubscribe: (() => void) | undefined;
  let progressTimer: number | undefined;
  let executionStartedAt = 0;

  const response = computed(() => responseView.value?.metadata ?? null);
  const responseBody = computed(() => responseView.value?.body ?? null);
  const responsePrettyBody = computed(
    () => responseView.value?.prettyBody ?? null,
  );

  function stopProgressClock(): void {
    if (progressTimer !== undefined) window.clearInterval(progressTimer);
    progressTimer = undefined;
  }

  function startProgressClock(progress: ExecutionProgressV1): void {
    stopProgressClock();
    executionProgress.value = progress;
    executionStartedAt = performance.now() - progress.elapsedMs;
    progressTimer = window.setInterval(() => {
      if (!options.busy.value || !executionProgress.value) return;
      executionProgress.value = {
        ...executionProgress.value,
        elapsedMs: Math.max(0, performance.now() - executionStartedAt),
      };
    }, 200);
  }

  function mergeSummary(summary: ExecutionSummaryV1): boolean {
    const current = summaries.get(summary.executionId);
    if (current && current.revision >= summary.revision) return false;
    summaries.set(summary.executionId, summary);
    return true;
  }

  async function loadResponse(summary: ExecutionSummaryV1): Promise<void> {
    if (!summary.responseHandle) return;
    const revision = ++responseLoadRevision;
    try {
      const [metadata, body, prettyBody] = await Promise.all([
        loadExecutionResponseMetadata(summary.responseHandle),
        loadExecutionResponseBody(summary.responseHandle),
        loadExecutionPrettyBody(summary.responseHandle),
      ]);
      if (revision !== responseLoadRevision) return;
      if (!metadata || !body) {
        throw new Error("The stored response handle is unavailable.");
      }
      if (
        metadata.handle !== summary.responseHandle ||
        metadata.executionId !== summary.executionId ||
        metadata.requestId !== summary.requestId
      ) {
        throw new Error(
          "The stored response handle does not match its execution.",
        );
      }
      const warning = localWarnings.get(summary.executionId);
      const displayedMetadata = warning
        ? { ...metadata, warnings: [...metadata.warnings, warning] }
        : metadata;
      responseView.value = {
        metadata: displayedMetadata,
        body,
        ...(prettyBody ? { prettyBody } : {}),
      };
      options.onResponseReady?.(displayedMetadata);
    } catch (error) {
      if (revision !== responseLoadRevision) return;
      options.errorMessage.value =
        error instanceof Error ? error.message : String(error);
    }
  }

  async function acceptSummary(summary: ExecutionSummaryV1): Promise<void> {
    if (!mergeSummary(summary)) return;
    const matchesPending =
      pendingRequestId !== "" && summary.requestId === pendingRequestId;
    if (!activeExecutionId.value && isActive(summary) && matchesPending) {
      activeExecutionId.value = summary.executionId;
    }
    if (summary.executionId !== activeExecutionId.value) {
      if (!activeExecutionId.value && summary.state === "succeeded") {
        await loadResponse(summary);
      }
      return;
    }

    executionProgress.value = summary.progress;
    if (isActive(summary)) {
      options.busy.value = true;
      startProgressClock(summary.progress);
      return;
    }

    stopProgressClock();
    options.busy.value = false;
    cancelling.value = false;
    activeExecutionId.value = "";
    if (summary.state === "succeeded") {
      await loadResponse(summary);
    } else {
      executionProgress.value = null;
      if (summary.error) options.errorMessage.value = summary.error.message;
    }
  }

  function handleEvent(event: ExecutionEventV1): void {
    if (event.type === "execution.snapshot") {
      const incoming = new Set(
        event.executions.map((item) => item.executionId),
      );
      for (const [id, summary] of summaries) {
        if (!incoming.has(id) && !isActive(summary)) summaries.delete(id);
      }
      for (const summary of event.executions) void acceptSummary(summary);
      return;
    }
    void acceptSummary(event.execution);
  }

  async function initialize(): Promise<void> {
    unsubscribe ??= subscribeExecutionEvents(handleEvent);
    const [preferences, persisted] = await Promise.all([
      loadExecutionPreferences(),
      listExecutionSummaries(),
    ]);
    retention.value = preferences.retention;
    responseLimitMiB.value = preferences.responseLimitBytes / MEBIBYTE;
    for (const summary of persisted) mergeSummary(summary);

    const successful = mostRecent(
      summaries.values(),
      (summary) =>
        summary.state === "succeeded" && Boolean(summary.responseHandle),
    );
    if (successful) await loadResponse(successful);
    const active = mostRecent(summaries.values(), isActive);
    if (active) {
      activeExecutionId.value = active.executionId;
      options.busy.value = true;
      startProgressClock(active.progress);
    }
  }

  function dispose(): void {
    unsubscribe?.();
    unsubscribe = undefined;
    stopProgressClock();
  }

  async function run(input: RunExecutionInput): Promise<void> {
    if (options.busy.value) return;
    options.errorMessage.value = "";
    options.notice.value = input.notice ?? "";
    options.busy.value = true;
    cancelling.value = false;
    pendingRequestId = input.request.id;
    startProgressClock({ phase: "preparing", loadedBytes: 0, elapsedMs: 0 });
    void nextTick(() =>
      document.querySelector<HTMLButtonElement>("button.stop-button")?.focus(),
    );
    try {
      const summary = await startBackgroundExecution({
        request: input.request,
        target: input.target,
        retention: retention.value,
        responseLimitBytes: Math.round(responseLimitMiB.value * MEBIBYTE),
        permissionAlreadyGranted: input.target.kind === "remote",
      });
      if (input.warning) {
        localWarnings.set(summary.executionId, input.warning);
        if (responseView.value?.metadata.executionId === summary.executionId) {
          responseView.value = {
            ...responseView.value,
            metadata: {
              ...responseView.value.metadata,
              warnings: [
                ...responseView.value.metadata.warnings,
                input.warning,
              ],
            },
          };
        }
      }
      if (!activeExecutionId.value && isActive(summary)) {
        activeExecutionId.value = summary.executionId;
      }
      await acceptSummary(summary);
    } catch (error) {
      stopProgressClock();
      options.busy.value = false;
      cancelling.value = false;
      activeExecutionId.value = "";
      executionProgress.value = null;
      options.errorMessage.value =
        error instanceof Error ? error.message : String(error);
    } finally {
      pendingRequestId = "";
    }
  }

  async function stop(): Promise<void> {
    if (!activeExecutionId.value || cancelling.value) return;
    cancelling.value = true;
    executionProgress.value = {
      phase: "cancelling",
      loadedBytes: executionProgress.value?.loadedBytes ?? 0,
      ...(executionProgress.value?.totalBytes === undefined
        ? {}
        : { totalBytes: executionProgress.value.totalBytes }),
      elapsedMs: Math.max(0, performance.now() - executionStartedAt),
    };
    try {
      await cancelBackgroundExecution(activeExecutionId.value);
    } catch (error) {
      cancelling.value = false;
      options.errorMessage.value =
        error instanceof Error ? error.message : String(error);
    }
  }

  async function showLatestForRequest(requestId: string): Promise<void> {
    const summary = mostRecent(
      summaries.values(),
      (item) =>
        item.requestId === requestId &&
        item.state === "succeeded" &&
        Boolean(item.responseHandle),
    );
    responseLoadRevision += 1;
    responseView.value = null;
    if (summary) await loadResponse(summary);
  }

  async function persistImportedResponses(
    responses: ResponseRecordV1[],
  ): Promise<void> {
    const imported = await Promise.all(
      responses.map((item) => persistImportedResponse(item, retention.value)),
    );
    for (const summary of imported) mergeSummary(summary);
    if (imported[0]) await loadResponse(imported[0]);
  }

  async function loadResponses(
    requestIds: ReadonlySet<string>,
  ): Promise<ResponseRecordV1[]> {
    const selected = new Map<string, ExecutionSummaryV1>();
    for (const summary of summaries.values()) {
      if (
        summary.state !== "succeeded" ||
        !summary.responseHandle ||
        !requestIds.has(summary.requestId)
      ) {
        continue;
      }
      const previous = selected.get(summary.requestId);
      if (!previous || previous.updatedAt < summary.updatedAt) {
        selected.set(summary.requestId, summary);
      }
    }
    return (
      await Promise.all(
        [...selected.values()].map((summary) =>
          loadExecutionResponse(summary.responseHandle!),
        ),
      )
    ).filter((item): item is ResponseRecordV1 => item !== undefined);
  }

  async function loadDisplayedResponse(): Promise<
    ResponseRecordV1 | undefined
  > {
    const handle = responseView.value?.metadata.handle;
    return handle ? loadExecutionResponse(handle) : undefined;
  }

  async function savePreferences(
    nextRetention = retention.value,
    nextLimitMiB = responseLimitMiB.value,
  ): Promise<void> {
    const saved = await saveExecutionPreferences({
      retention: nextRetention,
      responseLimitBytes: Math.round(nextLimitMiB * MEBIBYTE),
    });
    retention.value = saved.retention;
    responseLimitMiB.value = saved.responseLimitBytes / MEBIBYTE;
  }

  async function clearResults(): Promise<void> {
    await clearBackgroundExecutionResults();
    summaries.clear();
    responseLoadRevision += 1;
    responseView.value = null;
  }

  return {
    activeExecutionId,
    cancelling,
    clearResults,
    dispose,
    executionProgress,
    initialize,
    loadDisplayedResponse,
    loadResponses,
    persistImportedResponses,
    response,
    responseBody,
    responseLimitMiB,
    responsePrettyBody,
    retention,
    run,
    savePreferences,
    showLatestForRequest,
    stop,
  };
}
