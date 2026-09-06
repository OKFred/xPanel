<script setup lang="ts">
defineOptions({ name: "XPanelWorkbench" });

import { storeToRefs } from "pinia";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import type { CollectionRecord } from "@xpanel/contracts";

import BrowserCompatibilityDialog from "../dialog/BrowserCompatibilityDialog.vue";
import DeleteConfirmDialog from "../dialog/DeleteConfirmDialog.vue";
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
import { useExecutionWorkbench } from "../../composables/useExecutionWorkbench";
import { useRequestExecutionFlow } from "../../composables/useRequestExecutionFlow";
import { useWorkbenchCollectionActions } from "../../composables/useWorkbenchCollectionActions";
import { useWorkbenchPresentation } from "../../composables/useWorkbenchPresentation";
import { useWorkbenchResponseActions } from "../../composables/useWorkbenchResponseActions";
import { useWorkbenchStore } from "../../stores/workbench";

const store = useWorkbenchStore();
const props = withDefaults(
  defineProps<{ surface?: "devtools" | "standalone" }>(),
  { surface: "devtools" },
);
const {
  current,
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
const executionWorkbench = useExecutionWorkbench({
  busy,
  notice,
  errorMessage,
  onResponseReady(response) {
    responseTab.value = shouldAutoPretty(response.body.sizeBytes)
      ? "pretty"
      : "raw";
  },
});
const {
  cancelling,
  clearResults,
  executionProgress,
  loadDisplayedResponse,
  loadResponses,
  persistImportedResponses,
  response,
  responseBody,
  responseLimitMiB,
  responsePrettyBody,
  retention,
  run: runBackgroundExecution,
  savePreferences: saveExecutionPreferences,
  showLatestForRequest,
  stop: stopBackgroundExecution,
} = executionWorkbench;
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
} = useRequestTransfer(errorMessage, {
  persistImportedResponses,
  loadResponses,
});
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
const autoFilterBrowserHeaders = ref(false);
const {
  browserCompatibilityOpen,
  browserCompatibilityReasons,
  browserFilterableHeaderCount,
  chooseRemoteFromCompatibility,
  closeBrowserCompatibility,
  closeRemoteConsent,
  confirmRemoteSend,
  filterAndSendBrowserOnce,
  pendingRemoteSend,
  remoteConsentBusy,
  remoteConsentError,
  remoteConsentOpen,
  remoteConsentRelay,
  remoteConsentTarget,
  remoteTrustSession,
  send,
} = useRequestExecutionFlow({
  current,
  busy,
  notice,
  errorMessage,
  autoFilterBrowserHeaders,
  executorSelection,
  relayProfiles,
  selectedRelayProfile,
  openRelayManager,
  editRelayProfile,
  run: runBackgroundExecution,
  t,
});
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
const {
  displayedNotice,
  progressDetail,
  progressPercent,
  progressPhaseLabel,
  responseHeaders,
  responseTiming,
} = useWorkbenchPresentation({
  notice,
  progress: executionProgress,
  response,
  t,
});
const {
  beautifyBody,
  clearExecutionResults,
  compactBody,
  copyFullResponse,
  copyResponseBody,
  copyText,
  downloadResponseBody,
  updateResponseLimit,
  updateRetention,
} = useWorkbenchResponseActions({
  bodyText,
  clearResults,
  copied,
  current,
  errorMessage,
  loadResponse: loadDisplayedResponse,
  notice,
  responseBody,
  responseLimitMiB,
  retention,
  savePreferences: saveExecutionPreferences,
  t,
});
const {
  askDeleteCollection,
  askDeleteRequest,
  closeDeleteDialog,
  confirmDelete,
  createCollection,
  createNewRequest,
  deleteBusy,
  deleteCollectionRequests,
  deleteError,
  deleteTarget,
  loadSaved,
  toggleLocale,
} = useWorkbenchCollectionActions({
  busy,
  collections,
  current,
  displayCollectionName,
  locale,
  requests,
  showLatestForRequest,
  t,
});

onMounted(async () => {
  try {
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
    await Promise.all([
      initializeRelayState(),
      executionWorkbench.initialize(),
    ]);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
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
  executionWorkbench.dispose();
});

function stop(): void {
  void stopBackgroundExecution();
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
      @create-request="createNewRequest"
      @create-collection="createCollection"
      @load="loadSaved"
      @delete-request="askDeleteRequest"
      @delete-collection="askDeleteCollection"
      @toggle-locale="toggleLocale"
    />

    <section class="workspace">
      <WorkbenchHeader
        v-model:current="current"
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
          v-model:current="current"
          :tab="requestTab"
          :body-kind="bodyKind"
          :body-text="bodyText"
          :timeout-seconds="timeoutSecondsInput"
          :auto-filter-browser-headers="autoFilterBrowserHeaders"
          :persist-sensitive="persistSensitive"
          :has-hidden-browser-options="hasHiddenBrowserOptions"
          :busy="busy"
          :retention="retention"
          :response-limit-mi-b="responseLimitMiB"
          @update:tab="requestTab = $event"
          @update:body-text="bodyText = $event"
          @update:auto-filter-browser-headers="
            autoFilterBrowserHeaders = $event
          "
          @update:persist-sensitive="persistSensitive = $event"
          @update:retention="updateRetention"
          @update:response-limit-mi-b="updateResponseLimit"
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
          @clear-results="clearExecutionResults"
        />
        <ResponsePane
          :response="response"
          :body-source="responseBody"
          :pretty-source="responsePrettyBody"
          :busy="busy"
          :tab="responseTab"
          :headers-text="responseHeaders"
          :timing-text="responseTiming"
          :copied="copied"
          @update:tab="responseTab = $event"
          @copy-body="copyResponseBody"
          @copy-headers="copyText('response-headers', responseHeaders)"
          @copy-full="copyFullResponse"
          @download-body="downloadResponseBody"
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
      v-model:draft="relayDraft"
      :profiles="relayProfiles"
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
