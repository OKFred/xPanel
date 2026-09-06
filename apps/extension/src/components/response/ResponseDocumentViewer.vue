<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";

import {
  MAX_RENDERED_ROWS,
  type ResponseDocumentMode,
  visibleRowRange,
} from "./model";
import { ResponseDocumentWorkerClient } from "./worker-client";

const props = withDefaults(
  defineProps<{
    source: Blob | string;
    sizeBytes: number;
    mode: ResponseDocumentMode;
    ariaLabel?: string;
  }>(),
  { ariaLabel: "Response body" },
);

const emit = defineEmits<{
  ready: [
    metadata: { rowCount: number; formatted: boolean; virtualized: boolean },
  ];
  error: [message: string];
}>();

const ROW_HEIGHT = 17;
const OVERSCAN = 20;
const viewport = ref<HTMLElement>();
const rows = ref<string[]>([]);
const rowStart = ref(0);
const rowCount = ref(0);
const maxRowCharacters = ref(0);
const loading = ref(true);
const errorMessage = ref("");
const client = new ResponseDocumentWorkerClient();
let documentId = "";
let renderRevision = 0;
let resizeObserver: ResizeObserver | undefined;
let frame = 0;

const spacerStyle = computed(() => ({
  height: `${Math.max(1, rowCount.value) * ROW_HEIGHT}px`,
  minWidth: `${Math.max(1, maxRowCharacters.value) * 6.8}px`,
}));
const rowsStyle = computed(() => ({
  transform: `translateY(${rowStart.value * ROW_HEIGHT}px)`,
}));

async function prepare(): Promise<void> {
  const revision = ++renderRevision;
  loading.value = true;
  errorMessage.value = "";
  rows.value = [];
  if (documentId)
    void client.disposeDocument(documentId).catch(() => undefined);
  documentId = crypto.randomUUID();
  try {
    const source =
      typeof props.source === "string"
        ? new Blob([props.source])
        : props.source;
    const metadata = await client.prepare(
      documentId,
      source,
      props.mode,
      props.sizeBytes,
    );
    if (revision !== renderRevision) return;
    rowCount.value = metadata.rowCount;
    maxRowCharacters.value = metadata.maxRowCharacters;
    emit("ready", metadata);
    await nextTick();
    await refreshRows(revision);
  } catch (error) {
    if (revision !== renderRevision) return;
    errorMessage.value = error instanceof Error ? error.message : String(error);
    emit("error", errorMessage.value);
  } finally {
    if (revision === renderRevision) loading.value = false;
  }
}

async function refreshRows(revision = renderRevision): Promise<void> {
  const element = viewport.value;
  if (!element || !documentId || rowCount.value === 0) return;
  const range = visibleRowRange(
    element.scrollTop,
    element.clientHeight,
    rowCount.value,
    ROW_HEIGHT,
    OVERSCAN,
  );
  const response = await client.slice(documentId, range.start, range.count);
  if (revision !== renderRevision) return;
  rowStart.value = response.start;
  rows.value = response.rows.slice(0, MAX_RENDERED_ROWS);
}

function handleScroll(): void {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => void refreshRows());
}

async function getFullText(): Promise<string> {
  if (!documentId) return "";
  return client.fullText(documentId);
}

async function download(fileName = "xpanel-response.txt"): Promise<void> {
  const blob = new Blob([await getFullText()], {
    type: "text/plain;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

defineExpose({ getFullText, download });

watch(() => [props.source, props.mode, props.sizeBytes], prepare);
onMounted(() => {
  resizeObserver = new ResizeObserver(() => void refreshRows());
  if (viewport.value) resizeObserver.observe(viewport.value);
  void prepare();
});
onBeforeUnmount(() => {
  cancelAnimationFrame(frame);
  resizeObserver?.disconnect();
  client.terminate();
});
</script>

<template>
  <div
    ref="viewport"
    class="response-document-viewer"
    tabindex="0"
    :aria-label="ariaLabel"
    @scroll="handleScroll"
  >
    <div v-if="loading" class="viewer-status" role="status">Loading…</div>
    <div
      v-else-if="errorMessage"
      class="viewer-status viewer-error"
      role="alert"
    >
      {{ errorMessage }}
    </div>
    <div v-else class="viewer-spacer" :style="spacerStyle">
      <div class="viewer-rows" :style="rowsStyle">
        <div
          v-for="(row, index) in rows"
          :key="rowStart + index"
          class="viewer-row"
        >
          {{ row || "\u00a0" }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.response-document-viewer {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: auto;
  scrollbar-gutter: stable both-edges;
  background: #0b111e;
  color: #cbd7e8;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11px;
  line-height: 17px;
  outline: none;
}

.response-document-viewer:focus-visible {
  box-shadow: inset 0 0 0 2px #4f8cff;
}

.viewer-spacer {
  position: relative;
  box-sizing: content-box;
  padding: 0 14px;
}

.viewer-rows {
  position: absolute;
  top: 0;
  left: 14px;
  width: max-content;
  min-width: calc(100% - 28px);
}

.viewer-row {
  height: 17px;
  white-space: pre;
}

.viewer-status {
  display: grid;
  min-height: 100%;
  place-items: center;
  color: #75849b;
}

.viewer-error {
  color: #ff9ba8;
}
</style>
