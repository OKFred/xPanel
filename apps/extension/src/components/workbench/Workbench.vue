<script setup lang="ts">
import { storeToRefs } from "pinia";
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from "vue";
import { useI18n } from "vue-i18n";

import {
  compactJson,
  prettyJson,
} from "@xpanel/request-core";
import {
  type CollectionRecord,
  type ExecutionProgressV1,
  type RemoteRelayProfileV1,
  requestSpecV1Schema,
  type RequestSpecV1,
} from "@xpanel/contracts";

import BrowserCompatibilityDialog from "../dialog/BrowserCompatibilityDialog.vue";
import DeleteConfirmDialog, {
  type DeleteTarget,
} from "../dialog/DeleteConfirmDialog.vue";
import ExportRequestsDialog from "../dialog/ExportRequestsDialog.vue";
import ImportRequestsDialog from "../dialog/ImportRequestsDialog.vue";
import RelayManagerDialog from "../dialog/RelayManagerDialog.vue";
import RemoteConsentDialog from "../dialog/RemoteConsentDialog.vue";
import RequestEditorPane from "./RequestEditorPane.vue";
import ResponsePane from "./ResponsePane.vue";
import WorkbenchHeader from "./WorkbenchHeader.vue";
import WorkbenchSidebar from "./WorkbenchSidebar.vue";
import { shouldAutoPretty } from "../response/model";
import { useRequestTransfer } from "../../composables/useRequestTransfer";
import { useRelayWorkbench } from "../../composables/useRelayWorkbench";
import { useRequestEditor } from "../../composables/useRequestEditor";
import {
  browserUnsupportedReasons,
  cancelRequest,
  executeRequest,
  sanitizeBrowserRequestHeaders,
  type ExecuteTargetV1,
} from "../../lib/execute";
import {
  ensureRelayPermission,
  getRelayToken,
  isRelayTrusted,
  trustRelayForSession,
} from "../../lib/remote-profiles";
import { useWorkbenchStore } from "../../stores/workbench";

const store = useWorkbenchStore();
const props = withDefaults(
  defineProps<{ surface?: "devtools" | "standalone" }>(),
  { surface: "devtools" },
);
const {
  current,
  response,
  collections,
  requests,
  favorites,
  busy,
  notice,
  persistSensitive,
  selectedCollectionId,
} = storeToRefs(store);
const { locale, t } = useI18n();

const requestTab = ref<"params" | "headers" | "body" | "auth" | "options">(
  "params",
);
const responseTab = ref<"pretty" | "raw" | "headers" | "timing">("pretty");
const copied = ref("");
const errorMessage = ref("");
const {
  apiDocumentEncoding,
  changeSensitiveExport,
  detectedFormat,
  downloadExport,
  exportFormat,
  exportOpen,
  exportScope,
  exportText,
  exportWarnings,
  importCurrentHar,
  importOpen,
  importRequests,
  importText,
  importWarnings,
  includeSensitiveExport,
  openApiVersion,
  openExport,
  prepareExport,
  readImportFiles,
} = useRequestTransfer(errorMessage);
const {
  closeRelayManager,
  editRelayProfile,
  executorSelection,
  initializeRelayState,
  openRelayManager,
  relayCapabilities,
  relayDraft,
  relayManagerBusy,
  relayManagerError,
  relayManagerNotice,
  relayManagerOpen,
  relayPersistConfirmed,
  relayProfiles,
  relayTokenInput,
  removeRelayProfile,
  saveRelayDraft,
  selectedRelayProfile,
  startNewRelayProfile,
  testRelayDraft,
} = useRelayWorkbench();
const {
  addMultipartFile,
  addMultipartText,
  bodyKind,
  bodyText,
  clearHiddenBrowserOptions,
  hasHiddenBrowserOptions,
  normalizeTimeoutInput,
  removeMultipartPart,
  selectMultipartFile,
  selectRawBodyFile,
  setAuthKind,
  setBodyKind,
  timeoutEditing,
  timeoutSecondsInput,
  updateTimeoutInput,
} = useRequestEditor(errorMessage);
const activeExecutionId = ref("");
const activeExecutionRun = ref(0);
const executionProgress = ref<ExecutionProgressV1 | null>(null);
const cancelling = ref(false);
let progressTimer: number | undefined;
let executionStartedAt = 0;
const autoFilterBrowserHeaders = ref(false);
const remoteConsentOpen = ref(false);
const remoteConsentBusy = ref(false);
const remoteConsentError = ref("");
const remoteTrustSession = ref(false);
const pendingRemoteSend = shallowRef<{
  request: RequestSpecV1;
  profile: RemoteRelayProfileV1;
  token: string;
} | null>(null);
const browserCompatibilityOpen = ref(false);
const pendingBrowserRequest = shallowRef<RequestSpecV1 | null>(null);
const browserCompatibilityReasons = ref<string[]>([]);
const deleteTarget = ref<DeleteTarget | null>(null);
const deleteCollectionRequests = ref(false);
const deleteBusy = ref(false);
const deleteError = ref("");
const canImportCurrentHar = computed(
  () =>
    props.surface === "devtools" &&
    typeof chrome.devtools?.network?.getHAR === "function",
);

function displayCollectionName(collection: CollectionRecord): string {
  return collection.id === "collection-default" &&
    collection.name === "My requests"
    ? t("myRequests")
    : collection.name;
}
const displayedNotice = computed(() => {
  const value = notice.value;
  let match = value.match(
    /^(\d+) invalid saved record\(s\) were ignored\. Import a backup if data is missing\.$/u,
  );
  if (match) return t("invalidSavedRecords", { count: Number(match[1]) });
  if (value === "Deleted saved request.") return t("deletedSavedRequest");
  match = value.match(
    /^Deleted collection and (\d+) exclusive requests?; shared requests were kept\.$/u,
  );
  if (match) return t("deletedCollectionCascade", { count: Number(match[1]) });
  if (
    value ===
    "Deleted collection; its exclusive requests were moved to My requests."
  ) {
    return t("deletedCollectionMoved");
  }
  if (value === "Deleted collection; shared requests were kept.") {
    return t("deletedCollectionShared");
  }
  if (value === "Deleted collection.") return t("deletedCollection");
  if (value === "Saved locally with sensitive values.") {
    return t("savedWithSensitive");
  }
  if (value === "Saved locally with sensitive values redacted.") {
    return t("savedWithRedaction");
  }
  match = value.match(/^Imported (\d+) requests?\.$/u);
  return match ? t("importedRequests", { count: Number(match[1]) }) : value;
});
const progressPercent = computed(() => {
  const progress = executionProgress.value;
  if (
    !progress ||
    progress.totalBytes === undefined ||
    progress.phase === "uploading" ||
    progress.phase === "waiting" ||
    progress.phase === "requesting-permission"
  ) {
    return undefined;
  }
  if (progress.totalBytes === 0) return progress.phase === "complete" ? 100 : 0;
  return Math.min(100, (progress.loadedBytes / progress.totalBytes) * 100);
});
const progressPhaseLabel = computed(() => {
  const phase = executionProgress.value?.phase;
  if (!phase) return "";
  const keys: Record<ExecutionProgressV1["phase"], string> = {
    preparing: "progressPreparing",
    "requesting-permission": "progressRequestingPermission",
    uploading: "progressUploading",
    waiting: "progressWaiting",
    downloading: "progressDownloading",
    cancelling: "progressCancelling",
    complete: "progressComplete",
  };
  return t(keys[phase]);
});
const progressDetail = computed(() => {
  const progress = executionProgress.value;
  if (!progress) return "";
  const elapsed = formatElapsed(progress.elapsedMs);
  if (progress.phase === "uploading" && progress.totalBytes !== undefined) {
    return t("progressBodySize", {
      total: formatBytes(progress.totalBytes),
      elapsed,
    });
  }
  return progress.totalBytes === undefined
    ? t("progressTransferred", {
        bytes: formatBytes(progress.loadedBytes),
        elapsed,
      })
    : t("progressTransferredOf", {
        loaded: formatBytes(progress.loadedBytes),
        total: formatBytes(progress.totalBytes),
        elapsed,
      });
});
const remoteConsentTarget = computed(() => {
  try {
    return new URL(pendingRemoteSend.value?.request.url ?? "").origin;
  } catch {
    return pendingRemoteSend.value?.request.url ?? "";
  }
});
const remoteConsentRelay = computed(() => {
  try {
    return new URL(pendingRemoteSend.value?.profile.baseUrl ?? "").host;
  } catch {
    return pendingRemoteSend.value?.profile.baseUrl ?? "";
  }
});
const browserFilterableHeaderCount = computed(() => {
  if (!pendingBrowserRequest.value || autoFilterBrowserHeaders.value) return 0;
  return sanitizeBrowserRequestHeaders(
    pendingBrowserRequest.value,
  ).removedHeaders.reduce((total, header) => total + header.occurrences, 0);
});

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}

function formatElapsed(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1_000).toFixed(1)} s`;
}

const responseRaw = computed(() => {
  return response.value?.body.content ?? "";
});
const responseHeaders = computed(
  () =>
    response.value?.headers
      .map((header) => `${header.name}: ${header.value}`)
      .join("\n") ?? "",
);
const responseTiming = computed(() =>
  response.value ? JSON.stringify(response.value.timings, null, 2) : "",
);
const responseFull = computed(() => {
  if (!response.value) return "";
  return [
    `HTTP ${response.value.status} ${response.value.statusText}`.trim(),
    responseHeaders.value,
    "",
    responseRaw.value,
  ].join("\n");
});

onMounted(async () => {
  await store.initialize();
  const preferences = await chrome.storage.local.get([
    "locale",
    "persistSensitive",
    "autoFilterBrowserHeaders",
  ]);
  const savedLocale: unknown = preferences.locale;
  if (savedLocale === "zh-CN" || savedLocale === "en-US") {
    locale.value = savedLocale;
  }
  persistSensitive.value = preferences.persistSensitive === true;
  autoFilterBrowserHeaders.value =
    preferences.autoFilterBrowserHeaders === true;
  await initializeRelayState();
});

watch(locale, async (value) => {
  document.documentElement.lang = value;
  await chrome.storage.local.set({ locale: value });
});
watch(persistSensitive, async (value) =>
  chrome.storage.local.set({ persistSensitive: value }),
);
watch(autoFilterBrowserHeaders, async (value) =>
  chrome.storage.local.set({ autoFilterBrowserHeaders: value }),
);
onBeforeUnmount(() => {
  stopProgressClock();
  if (activeExecutionId.value) cancelRequest(activeExecutionId.value);
});

interface BrowserFilteredResult {
  request: RequestSpecV1;
  notice: string;
  warning?: { code: string; message: string; path: string };
}

function filterBrowserExecutionCopy(
  request: RequestSpecV1,
): BrowserFilteredResult {
  const sanitized = sanitizeBrowserRequestHeaders(request);
  if (sanitized.removedHeaders.length === 0) {
    return { request: sanitized.request, notice: "" };
  }
  const count = sanitized.removedHeaders.reduce(
    (total, header) => total + header.occurrences,
    0,
  );
  const headers = sanitized.removedHeaders
    .map((header) => header.name)
    .join(", ");
  return {
    request: sanitized.request,
    notice: t("browserHeadersFilteredNotice", { count, headers }),
    warning: {
      code: "browser.headers_filtered",
      message: t("browserHeadersFilteredWarning", { count, headers }),
      path: "headers",
    },
  };
}

function beginProgress(): void {
  executionStartedAt = performance.now();
  executionProgress.value = {
    phase: "preparing",
    loadedBytes: 0,
    elapsedMs: 0,
  };
  if (progressTimer !== undefined) window.clearInterval(progressTimer);
  progressTimer = window.setInterval(() => {
    if (!executionProgress.value || !busy.value) return;
    executionProgress.value = {
      ...executionProgress.value,
      elapsedMs: Math.max(0, performance.now() - executionStartedAt),
    };
  }, 200);
}

function stopProgressClock(): void {
  if (progressTimer !== undefined) window.clearInterval(progressTimer);
  progressTimer = undefined;
}

async function runExecution(
  request: RequestSpecV1,
  target: ExecuteTargetV1,
  filtered: BrowserFilteredResult = { request, notice: "" },
): Promise<void> {
  if (busy.value) return;
  const run = activeExecutionRun.value + 1;
  activeExecutionRun.value = run;
  busy.value = true;
  void nextTick(() =>
    document.querySelector<HTMLButtonElement>("button.stop-button")?.focus(),
  );
  cancelling.value = false;
  notice.value = t("sending");
  activeExecutionId.value = request.id;
  beginProgress();
  try {
    const executedResponse = await executeRequest(filtered.request, {
      target,
      relayPermissionAlreadyGranted: target.kind === "remote",
      onProgress(progress) {
        if (activeExecutionRun.value === run)
          executionProgress.value = progress;
      },
    });
    if (activeExecutionRun.value !== run || cancelling.value) return;
    store.setResponse(
      filtered.warning
        ? {
            ...executedResponse,
            warnings: [...executedResponse.warnings, filtered.warning],
          }
        : executedResponse,
    );
    responseTab.value = shouldAutoPretty(executedResponse.body.sizeBytes)
      ? "pretty"
      : "raw";
    notice.value = filtered.notice;
    executionProgress.value = {
      ...(executionProgress.value ?? {
        loadedBytes: executedResponse.body.sizeBytes,
      }),
      phase: "complete",
      elapsedMs: performance.now() - executionStartedAt,
    };
  } catch (error) {
    if (activeExecutionRun.value !== run) return;
    notice.value = filtered.notice;
    errorMessage.value = error instanceof Error ? error.message : String(error);
    executionProgress.value = null;
  } finally {
    if (activeExecutionRun.value === run) {
      const restoreSendFocus =
        document.activeElement instanceof HTMLElement &&
        document.activeElement.classList.contains("stop-button");
      stopProgressClock();
      busy.value = false;
      cancelling.value = false;
      activeExecutionId.value = "";
      if (restoreSendFocus) {
        void nextTick(() =>
          document
            .querySelector<HTMLButtonElement>("button.send-button")
            ?.focus(),
        );
      }
    }
  }
}

async function send(): Promise<void> {
  if (busy.value) return;
  errorMessage.value = "";
  notice.value = "";
  executionProgress.value = null;
  if (!current.value.url.trim()) {
    errorMessage.value = t("enterUrl");
    return;
  }

  let request: RequestSpecV1;
  try {
    request = requestSpecV1Schema.parse(current.value);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
    return;
  }

  if (executorSelection.value === "browser") {
    const filtered = autoFilterBrowserHeaders.value
      ? filterBrowserExecutionCopy(request)
      : { request, notice: "" };
    const reasons = browserUnsupportedReasons(filtered.request);
    if (reasons.length > 0) {
      pendingBrowserRequest.value = request;
      browserCompatibilityReasons.value = reasons;
      browserCompatibilityOpen.value = true;
      return;
    }
    await runExecution(request, { kind: "browser" }, filtered);
    return;
  }

  const profile = selectedRelayProfile.value;
  if (!profile) {
    executorSelection.value = "browser";
    errorMessage.value = t("noRelayProfiles");
    return;
  }
  try {
    await ensureRelayPermission(profile);
    const token = await getRelayToken(profile);
    if (!token) {
      errorMessage.value = t("relayTokenRequired");
      await openRelayManager();
      editRelayProfile(profile);
      return;
    }
    if (!(await isRelayTrusted(profile, token))) {
      pendingRemoteSend.value = { request, profile, token };
      remoteTrustSession.value = false;
      remoteConsentError.value = "";
      remoteConsentOpen.value = true;
      return;
    }
    await runExecution(request, { kind: "remote", profile, token });
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

async function filterAndSendBrowserOnce(): Promise<void> {
  const request = pendingBrowserRequest.value;
  if (!request) return;
  const filtered = filterBrowserExecutionCopy(request);
  const remaining = browserUnsupportedReasons(filtered.request);
  browserCompatibilityOpen.value = false;
  pendingBrowserRequest.value = null;
  if (remaining.length > 0) {
    errorMessage.value = t("browserCannotPreserve", {
      reasons: remaining.join(", "),
    });
    notice.value = filtered.notice;
    return;
  }
  await runExecution(request, { kind: "browser" }, filtered);
}

async function chooseRemoteFromCompatibility(): Promise<void> {
  browserCompatibilityOpen.value = false;
  pendingBrowserRequest.value = null;
  if (relayProfiles.value.length === 0) {
    await nextTick();
    await openRelayManager();
    return;
  }
  executorSelection.value = relayProfiles.value[0]!.id;
  notice.value = t("remoteNotAutomatic");
}

function closeBrowserCompatibility(): void {
  browserCompatibilityOpen.value = false;
  pendingBrowserRequest.value = null;
}

async function confirmRemoteSend(): Promise<void> {
  if (remoteConsentBusy.value) return;
  const pending = pendingRemoteSend.value;
  if (!pending) return;
  remoteConsentBusy.value = true;
  remoteConsentError.value = "";
  try {
    if (remoteTrustSession.value) {
      await trustRelayForSession(pending.profile, pending.token);
    }
    remoteConsentOpen.value = false;
    pendingRemoteSend.value = null;
    await runExecution(pending.request, {
      kind: "remote",
      profile: pending.profile,
      token: pending.token,
    });
  } catch (error) {
    remoteConsentError.value =
      error instanceof Error ? error.message : String(error);
  } finally {
    remoteConsentBusy.value = false;
  }
}

function closeRemoteConsent(): void {
  if (remoteConsentBusy.value) return;
  remoteConsentOpen.value = false;
  pendingRemoteSend.value = null;
  remoteTrustSession.value = false;
  remoteConsentError.value = "";
}

function stop(): void {
  if (!activeExecutionId.value || cancelling.value) return;
  cancelling.value = true;
  executionProgress.value = {
    phase: "cancelling",
    loadedBytes: executionProgress.value?.loadedBytes ?? 0,
    ...(executionProgress.value?.totalBytes === undefined
      ? {}
      : { totalBytes: executionProgress.value.totalBytes }),
    elapsedMs: performance.now() - executionStartedAt,
  };
  cancelRequest(activeExecutionId.value);
}

function beautifyBody(): void {
  try {
    bodyText.value = prettyJson(bodyText.value);
    notice.value = t("formatted");
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

function compactBody(): void {
  try {
    bodyText.value = compactJson(bodyText.value);
    notice.value = t("compacted");
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

async function copyText(label: string, value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    copied.value = label;
    window.setTimeout(() => {
      if (copied.value === label) copied.value = "";
    }, 1500);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

function toggleLocale(): void {
  locale.value = locale.value === "zh-CN" ? "en-US" : "zh-CN";
}

async function createCollection(): Promise<void> {
  const name = window.prompt(t("collectionName"))?.trim();
  if (name) await store.createCollection(name);
}

function loadSaved(request: RequestSpecV1, collectionId?: string): void {
  store.loadRequest(request.id, collectionId);
}

function askDeleteRequest(request: RequestSpecV1): void {
  deleteCollectionRequests.value = false;
  deleteError.value = "";
  deleteTarget.value = {
    kind: "request",
    id: request.id,
    name: request.name,
  };
}

function askDeleteCollection(collection: CollectionRecord): void {
  const savedRequestIds = new Set(requests.value.map((request) => request.id));
  const collectionRequestIds = [
    ...new Set(
      collection.requestIds.filter((requestId) =>
        savedRequestIds.has(requestId),
      ),
    ),
  ];
  const sharedRequestCount = collectionRequestIds.filter((requestId) =>
    collections.value.some(
      (candidate) =>
        candidate.id !== collection.id &&
        candidate.requestIds.includes(requestId),
    ),
  ).length;
  deleteCollectionRequests.value = false;
  deleteError.value = "";
  deleteTarget.value = {
    kind: "collection",
    id: collection.id,
    name: displayCollectionName(collection),
    requestCount: collectionRequestIds.length,
    exclusiveRequestCount: collectionRequestIds.length - sharedRequestCount,
    sharedRequestCount,
  };
}

function closeDeleteDialog(): void {
  if (deleteBusy.value) return;
  deleteTarget.value = null;
  deleteCollectionRequests.value = false;
  deleteError.value = "";
}

async function confirmDelete(): Promise<void> {
  const target = deleteTarget.value;
  if (!target || busy.value || deleteBusy.value) return;

  deleteBusy.value = true;
  deleteError.value = "";
  try {
    if (target.kind === "request") {
      await store.deleteRequest(target.id);
    } else {
      await store.deleteCollection(target.id, deleteCollectionRequests.value);
    }
    deleteTarget.value = null;
    deleteCollectionRequests.value = false;
  } catch (error) {
    deleteError.value =
      error instanceof Error ? error.message : t("deleteFailed");
  } finally {
    deleteBusy.value = false;
  }
}
</script>

<template>
  <main class="workbench-shell">
    <WorkbenchSidebar
      :collections="collections"
      :requests="requests"
      :favorites="favorites"
      :current-id="current.id"
      :busy="busy"
      :delete-busy="deleteBusy"
      :surface="props.surface"
      :display-collection-name="displayCollectionName"
      @create-request="store.newRequest()"
      @create-collection="createCollection"
      @load="loadSaved"
      @delete-request="askDeleteRequest"
      @delete-collection="askDeleteCollection"
      @toggle-locale="toggleLocale"
    />

    <section class="workspace">
      <WorkbenchHeader
        :current="current"
        :collections="collections"
        :selected-collection-id="selectedCollectionId"
        :relay-profiles="relayProfiles"
        :executor-selection="executorSelection"
        :busy="busy"
        :cancelling="cancelling"
        :progress="executionProgress"
        :progress-percent="progressPercent"
        :progress-phase-label="progressPhaseLabel"
        :progress-detail="progressDetail"
        :display-collection-name="displayCollectionName"
        @update:selected-collection-id="selectedCollectionId = $event"
        @update:executor-selection="executorSelection = $event"
        @import="importOpen = true"
        @export="openExport"
        @favorite="store.toggleFavorite()"
        @save="store.saveCurrent()"
        @manage-relays="openRelayManager"
        @send="send"
        @stop="stop"
      >
        <template #message>
          <div
            v-if="displayedNotice || errorMessage"
            class="message-strip"
            :data-error="Boolean(errorMessage)"
          >
            <template v-if="errorMessage">
              {{ errorMessage }}<br v-if="displayedNotice" />
            </template>
            {{ displayedNotice }}
          </div>
        </template>
      </WorkbenchHeader>

      <div class="split-pane">
        <RequestEditorPane
          :current="current"
          :tab="requestTab"
          :body-kind="bodyKind"
          :body-text="bodyText"
          :timeout-seconds="timeoutSecondsInput"
          :auto-filter-browser-headers="autoFilterBrowserHeaders"
          :persist-sensitive="persistSensitive"
          :has-hidden-browser-options="hasHiddenBrowserOptions"
          @update:tab="requestTab = $event"
          @update:body-text="bodyText = $event"
          @update:auto-filter-browser-headers="autoFilterBrowserHeaders = $event"
          @update:persist-sensitive="persistSensitive = $event"
          @timeout-focus="timeoutEditing = true"
          @timeout-input="updateTimeoutInput"
          @timeout-blur="normalizeTimeoutInput"
          @body-kind="setBodyKind"
          @auth-kind="setAuthKind"
          @pretty-body="beautifyBody"
          @compact-body="compactBody"
          @raw-file="selectRawBodyFile"
          @add-multipart-text="addMultipartText"
          @add-multipart-file="addMultipartFile"
          @multipart-file="selectMultipartFile"
          @remove-multipart="removeMultipartPart"
          @clear-unsupported="clearHiddenBrowserOptions"
        />
        <ResponsePane
          :response="response"
          :busy="busy"
          :tab="responseTab"
          :headers-text="responseHeaders"
          :timing-text="responseTiming"
          :copied="copied"
          @update:tab="responseTab = $event"
          @copy-body="copyText('body', responseRaw)"
          @copy-headers="copyText('response-headers', responseHeaders)"
          @copy-full="copyText('full-response', responseFull)"
          @viewer-error="errorMessage = $event"
        />
      </div>
    </section>

    <BrowserCompatibilityDialog
      v-if="browserCompatibilityOpen"
      :reasons="browserCompatibilityReasons"
      :filterable-header-count="browserFilterableHeaderCount"
      @close="closeBrowserCompatibility"
      @filter="filterAndSendBrowserOnce"
      @remote="chooseRemoteFromCompatibility"
    />
    <RelayManagerDialog
      v-if="relayManagerOpen"
      v-model:token="relayTokenInput"
      v-model:persist-confirmed="relayPersistConfirmed"
      :profiles="relayProfiles"
      :draft="relayDraft"
      :busy="relayManagerBusy"
      :error="relayManagerError"
      :notice="relayManagerNotice"
      :capabilities="relayCapabilities"
      @close="closeRelayManager"
      @create="startNewRelayProfile"
      @edit="editRelayProfile"
      @remove="removeRelayProfile"
      @test="testRelayDraft"
      @save="saveRelayDraft"
    />
    <RemoteConsentDialog
      v-if="remoteConsentOpen && pendingRemoteSend"
      v-model:trust-session="remoteTrustSession"
      :busy="remoteConsentBusy"
      :error="remoteConsentError"
      :target="remoteConsentTarget"
      :relay="remoteConsentRelay"
      :base-url="pendingRemoteSend.profile.baseUrl"
      @close="closeRemoteConsent"
      @confirm="confirmRemoteSend"
    />
    <DeleteConfirmDialog
      v-if="deleteTarget"
      v-model:delete-collection-requests="deleteCollectionRequests"
      :target="deleteTarget"
      :busy="busy"
      :operation-busy="deleteBusy"
      :error="deleteError"
      @close="closeDeleteDialog"
      @confirm="confirmDelete"
    />
    <ImportRequestsDialog
      v-if="importOpen"
      v-model:text="importText"
      :detected-format="detectedFormat"
      :warnings="importWarnings"
      :can-import-current-har="canImportCurrentHar"
      @close="importOpen = false"
      @files="readImportFiles"
      @current-har="importCurrentHar"
      @import="importRequests"
    />
    <ExportRequestsDialog
      v-if="exportOpen"
      v-model:format="exportFormat"
      v-model:scope="exportScope"
      v-model:open-api-version="openApiVersion"
      v-model:encoding="apiDocumentEncoding"
      v-model:text="exportText"
      :include-sensitive="includeSensitiveExport"
      :warnings="exportWarnings"
      :copied="copied === 'export'"
      @close="exportOpen = false"
      @prepare="prepareExport"
      @sensitive="changeSensitiveExport"
      @copy="copyText('export', exportText)"
      @download="downloadExport"
    />
  </main>
</template>
