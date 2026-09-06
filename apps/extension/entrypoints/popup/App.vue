<script setup lang="ts">
import { ExternalLink, LoaderCircle } from "lucide-vue-next";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";

import type {
  ExecutionEventV1,
  ExecutionStateV1,
  ExecutionSummaryV1,
} from "@xpanel/contracts";

import {
  listExecutionSummaries,
  subscribeExecutionEvents,
} from "../../src/lib/execution-client";

const { t } = useI18n();
const version = chrome.runtime.getManifest().version;
const executions = ref<ExecutionSummaryV1[]>([]);
const opening = ref(false);
let unsubscribe: (() => void) | undefined;

const runningCount = computed(
  () =>
    executions.value.filter(
      (execution) =>
        execution.state === "queued" || execution.state === "running",
    ).length,
);
const latestExecution = computed(() =>
  [...executions.value].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0],
);

function stateLabel(state: ExecutionStateV1): string {
  const keys: Record<ExecutionStateV1, string> = {
    queued: "executionQueued",
    running: "executionRunning",
    succeeded: "executionSucceeded",
    failed: "executionFailed",
    cancelled: "executionCancelled",
    orphaned: "executionOrphaned",
  };
  return t(keys[state]);
}

function applyExecution(execution: ExecutionSummaryV1): void {
  const index = executions.value.findIndex(
    (item) => item.executionId === execution.executionId,
  );
  if (index < 0) executions.value.push(execution);
  else if (execution.revision >= executions.value[index]!.revision) {
    executions.value.splice(index, 1, execution);
  }
}

function handleExecutionEvent(event: ExecutionEventV1): void {
  if (event.type === "execution.snapshot") {
    executions.value = event.executions;
  } else {
    applyExecution(event.execution);
  }
}

async function openWorkbench(): Promise<void> {
  if (opening.value) return;
  opening.value = true;
  try {
    const url = chrome.runtime.getURL("workbench.html");
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["TAB"],
    });
    const existing = contexts.find(
      (context) =>
        context.tabId !== undefined && context.documentUrl?.startsWith(url),
    );
    if (existing?.tabId !== undefined) {
      await chrome.tabs.update(existing.tabId, { active: true });
      if (existing.windowId !== undefined) {
        await chrome.windows.update(existing.windowId, { focused: true });
      }
    } else {
      await chrome.tabs.create({ url });
    }
    window.close();
  } finally {
    opening.value = false;
  }
}

onMounted(async () => {
  executions.value = await listExecutionSummaries();
  unsubscribe = subscribeExecutionEvents(handleExecutionEvent);
});
onBeforeUnmount(() => unsubscribe?.());
</script>

<template>
  <main class="popup-shell">
    <header class="popup-brand">
      <div class="brand-mark">x</div>
      <div>
        <h1>xPanel</h1>
        <p>{{ $t("extensionVersion", { version }) }}</p>
      </div>
    </header>
    <section class="popup-status" aria-live="polite">
      <LoaderCircle v-if="runningCount" class="spin" :size="15" />
      <span>
        {{
          runningCount
            ? $t("runningRequests", { count: runningCount })
            : $t("noRunningRequests")
        }}
      </span>
      <small v-if="latestExecution">
        {{
          $t("recentExecution", {
            state: stateLabel(latestExecution.state),
          })
        }}
      </small>
    </section>
    <button
      class="primary-button popup-open"
      type="button"
      :disabled="opening"
      @click="openWorkbench"
    >
      <LoaderCircle v-if="opening" class="spin" :size="16" />
      <ExternalLink v-else :size="16" />
      {{ $t("openWorkbench") }}
    </button>
    <p class="popup-hint">{{ $t("openWorkbenchHint") }}</p>
  </main>
</template>
