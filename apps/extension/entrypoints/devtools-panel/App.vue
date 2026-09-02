<script setup lang="ts">
import {
  Braces,
  Check,
  Clipboard,
  Download,
  FileInput,
  Folder,
  Globe2,
  Heart,
  Languages,
  LoaderCircle,
  PanelLeft,
  Play,
  Plus,
  Save,
  Square,
  Upload,
  X,
} from "lucide-vue-next";
import { storeToRefs } from "pinia";
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { strToU8, zipSync } from "fflate";
import { stringify as stringifyYaml } from "yaml";

import {
  compactJson,
  detectImportFormat,
  exportHarWithWarnings,
  exportCollectionFileWithWarnings,
  exportOpenApi,
  exportRequest,
  exportSwagger,
  parseImport,
  prettyJson,
  type ExportFormat,
} from "@xpanel/request-core";
import {
  type AuthSpec,
  type BodySpec,
  collectionRecordSchema,
  type FileReferenceV1,
  requestSpecV1Schema,
  type RequestSpecV1,
} from "@xpanel/contracts";

import KeyValueEditor from "../../src/components/KeyValueEditor.vue";
import { Button } from "../../src/components/ui/button";
import { cancelRequest, executeRequest } from "../../src/lib/execute";
import { bindFile, unbindFile } from "../../src/lib/file-bindings";
import { useWorkbenchStore } from "../../src/stores/workbench";

const store = useWorkbenchStore();
const {
  current,
  response,
  responses,
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
const importOpen = ref(false);
const exportOpen = ref(false);
const importText = ref("");
const importFileName = ref("");
const importBaseUrl = ref("");
const importResources = new Map<string, string>();
const approvedReferenceOrigins = new Set<string>();
const importWarnings = ref<string[]>([]);
const MAX_REMOTE_REFERENCE_BYTES = 5 * 1024 * 1024;
const exportFormat = ref<ExportFormat>("curl-bash");
const exportScope = ref<"current" | "saved">("current");
const openApiVersion = ref<"3.0.3" | "3.1.0" | "3.2.0">("3.1.0");
const apiDocumentEncoding = ref<"json" | "yaml">("json");
const exportText = ref("");
const exportWarnings = ref<string[]>([]);
const includeSensitiveExport = ref(false);
const exportDocuments = ref<Record<string, Record<string, unknown>> | null>(
  null,
);
const exportExtension = ref("txt");
const exportMediaType = ref("text/plain");
const copied = ref("");
const errorMessage = ref("");
const activeExecutionId = ref("");
const fileInput = ref<HTMLInputElement>();
const timeoutSecondsInput = ref("");
const timeoutEditing = ref(false);

const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 86_400_000;
const MIN_TIMEOUT_SECONDS = MIN_TIMEOUT_MS / 1_000;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1_000;
const TIMEOUT_RANGE_MESSAGE =
  "Timeout must be between 0.001 and 86400 seconds.";

const detectedFormat = computed(() =>
  detectImportFormat(importText.value, importFileName.value),
);
const bodyKind = computed(() => current.value.body.kind);

function formatTimeoutSeconds(timeoutMs: number): string {
  return (timeoutMs / 1_000).toString();
}

function parseTimeoutSeconds(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const seconds = Number(value);
  if (
    !Number.isFinite(seconds) ||
    seconds < MIN_TIMEOUT_SECONDS ||
    seconds > MAX_TIMEOUT_SECONDS
  ) {
    return undefined;
  }
  const timeoutMs = Math.round(seconds * 1_000);
  if (timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    return undefined;
  }
  return timeoutMs;
}

function updateTimeoutInput(event: Event): void {
  const value = (event.currentTarget as HTMLInputElement).value;
  timeoutSecondsInput.value = value;
  const timeoutMs = parseTimeoutSeconds(value);
  if (timeoutMs !== undefined) current.value.options.timeoutMs = timeoutMs;
}

function normalizeTimeoutInput(): void {
  timeoutEditing.value = false;
  const timeoutMs = parseTimeoutSeconds(timeoutSecondsInput.value);
  if (timeoutMs === undefined) {
    timeoutSecondsInput.value = formatTimeoutSeconds(
      current.value.options.timeoutMs,
    );
    errorMessage.value = TIMEOUT_RANGE_MESSAGE;
    return;
  }
  current.value.options.timeoutMs = timeoutMs;
  timeoutSecondsInput.value = formatTimeoutSeconds(timeoutMs);
  if (errorMessage.value === TIMEOUT_RANGE_MESSAGE) errorMessage.value = "";
}

watch(
  () => [current.value.id, current.value.options.timeoutMs] as const,
  ([, timeoutMs]) => {
    if (!timeoutEditing.value) {
      timeoutSecondsInput.value = formatTimeoutSeconds(timeoutMs);
    }
  },
  { immediate: true },
);
const hasHiddenBrowserOptions = computed(
  () =>
    current.value.options.proxy !== null ||
    !current.value.options.tls.verify ||
    current.value.options.tls.caFile !== undefined ||
    current.value.options.tls.clientCertificate !== undefined ||
    (current.value.body.kind === "multipart" &&
      current.value.body.parts.some(
        (part) =>
          part.enabled &&
          part.headers?.some(
            (header) => header.enabled && header.name.trim() !== "",
          ),
      )),
);
const bodyText = computed({
  get: () =>
    current.value.body.kind === "json" || current.value.body.kind === "text"
      ? current.value.body.text
      : "",
  set: (text: string) => {
    if (
      current.value.body.kind === "json" ||
      current.value.body.kind === "text"
    ) {
      current.value.body.text = text;
    }
  },
});
const responseRaw = computed(() => {
  return response.value?.body.content ?? "";
});
const responsePretty = computed(() => {
  const raw = responseRaw.value;
  if (!raw) return "";
  try {
    return prettyJson(raw);
  } catch {
    return raw;
  }
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
  ]);
  await chrome.storage.local.remove("executor");
  const savedLocale: unknown = preferences.locale;
  if (savedLocale === "zh-CN" || savedLocale === "en-US") {
    locale.value = savedLocale;
  }
  persistSensitive.value = preferences.persistSensitive === true;
});

watch(locale, async (value) => {
  document.documentElement.lang = value;
  await chrome.storage.local.set({ locale: value });
});
watch(persistSensitive, async (value) =>
  chrome.storage.local.set({ persistSensitive: value }),
);

function filePlaceholder(name: string): FileReferenceV1 {
  return {
    id: crypto.randomUUID(),
    name,
    requiresReselection: true,
  };
}

function addMultipartText(): void {
  if (current.value.body.kind !== "multipart") return;
  current.value.body.parts.push({
    kind: "text",
    name: "",
    value: "",
    enabled: true,
  });
}

function addMultipartFile(): void {
  if (current.value.body.kind !== "multipart") return;
  current.value.body.parts.push({
    kind: "file",
    name: "file",
    file: filePlaceholder("Select a file"),
    enabled: true,
  });
}

function removeMultipartPart(index: number): void {
  if (current.value.body.kind !== "multipart") return;
  const part = current.value.body.parts[index];
  if (part?.kind === "file") unbindFile(part.file.id);
  current.value.body.parts.splice(index, 1);
}

function selectMultipartFile(index: number, event: Event): void {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file || current.value.body.kind !== "multipart") return;
  const part = current.value.body.parts[index];
  if (part?.kind !== "file") return;
  part.file = bindFile(part.file, file);
}

function selectRawBodyFile(event: Event): void {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file || current.value.body.kind !== "file") return;
  current.value.body.file = bindFile(current.value.body.file, file);
  if (file.type) current.value.body.mediaType = file.type;
}

function clearHiddenBrowserOptions(): void {
  const tls = current.value.options.tls;
  if (tls.caFile) unbindFile(tls.caFile.id);
  if (tls.clientCertificate) {
    unbindFile(tls.clientCertificate.certificate.id);
    unbindFile(tls.clientCertificate.privateKey.id);
  }
  current.value.options.proxy = null;
  current.value.options.tls = { verify: true };
  if (current.value.body.kind === "multipart") {
    for (const part of current.value.body.parts) delete part.headers;
  }
  notice.value =
    "Browser-unsupported proxy, TLS, and multipart header options were cleared.";
}

function setBodyKind(kind: BodySpec["kind"]): void {
  if (current.value.body.kind === "file")
    unbindFile(current.value.body.file.id);
  if (current.value.body.kind === "multipart") {
    for (const part of current.value.body.parts) {
      if (part.kind === "file") unbindFile(part.file.id);
    }
  }
  const bodies: Record<BodySpec["kind"], BodySpec> = {
    none: { kind: "none" },
    text: { kind: "text", text: "", mediaType: "text/plain" },
    json: { kind: "json", text: "{}", mediaType: "application/json" },
    file: { kind: "file", file: filePlaceholder("Select a body file") },
    urlencoded: { kind: "urlencoded", entries: [] },
    multipart: { kind: "multipart", parts: [] },
  };
  current.value.body = bodies[kind];
}

function updateMethod(event: Event): void {
  current.value.method = (event.target as HTMLInputElement).value
    .trim()
    .toUpperCase();
}

function setAuthKind(kind: AuthSpec["kind"]): void {
  const auth: Record<AuthSpec["kind"], AuthSpec> = {
    none: { kind: "none" },
    basic: { kind: "basic", username: "", password: "" },
    bearer: { kind: "bearer", token: "" },
    "api-key": {
      kind: "api-key",
      location: "header",
      name: "X-API-Key",
      value: "",
    },
    oauth2: { kind: "oauth2", accessToken: "", tokenType: "Bearer" },
  };
  current.value.auth = auth[kind];
}

async function send(): Promise<void> {
  if (busy.value) return;
  errorMessage.value = "";
  notice.value = "";
  if (!current.value.url.trim()) {
    errorMessage.value = t("enterUrl");
    return;
  }
  busy.value = true;
  notice.value = t("sending");
  try {
    const request = requestSpecV1Schema.parse(current.value);
    activeExecutionId.value = request.id;
    store.setResponse(await executeRequest(request));
    responseTab.value = "pretty";
    notice.value = "";
  } catch (error) {
    notice.value = "";
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
    activeExecutionId.value = "";
  }
}

function stop(): void {
  if (activeExecutionId.value) cancelRequest(activeExecutionId.value);
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

async function importRequests(): Promise<void> {
  importWarnings.value = [];
  errorMessage.value = "";
  try {
    const result = await parseImport(importText.value, {
      ...(importFileName.value ? { fileName: importFileName.value } : {}),
      ...(importBaseUrl.value ? { baseUrl: importBaseUrl.value } : {}),
      resolveExternalRef: resolveImportReference,
    });
    importWarnings.value = result.warnings.map((item) => item.message);
    if (result.requests.length === 0) {
      throw new Error(
        "No static request could be imported. Review the unresolved input warnings.",
      );
    }
    await store.addImported(
      result.requests,
      result.collections,
      result.responses,
    );
    if (importWarnings.value.length === 0) importOpen.value = false;
    else
      notice.value = `Imported with ${importWarnings.value.length} warning(s); review the import dialog.`;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

async function readImportFiles(event: Event): Promise<void> {
  const files = [...((event.target as HTMLInputElement).files ?? [])];
  const primary = files[0];
  if (!primary) return;
  importResources.clear();
  for (const file of files) {
    const relativeName = file.webkitRelativePath || file.name;
    importResources.set(
      new URL(relativeName, "https://xpanel.local/").href,
      await file.text(),
    );
  }
  const primaryName = primary.webkitRelativePath || primary.name;
  importFileName.value = primary.name;
  importBaseUrl.value = new URL(primaryName, "https://xpanel.local/").href;
  importText.value =
    importResources.get(importBaseUrl.value) ?? (await primary.text());
}

async function resolveImportReference(absoluteUrl: string): Promise<string> {
  const url = new URL(absoluteUrl);
  if (url.origin === "https://xpanel.local") {
    const local = importResources.get(url.href);
    if (local === undefined)
      throw new Error(`Select the referenced local file: ${url.pathname}`);
    return local;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`External $ref protocol is not allowed: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error(
      "Credentials embedded in an external $ref URL are not allowed.",
    );
  }
  if (!approvedReferenceOrigins.has(url.origin)) {
    if (
      !window.confirm(
        `Allow this import to resolve external OpenAPI references from ${url.origin}?`,
      )
    ) {
      throw new Error(
        `External references from ${url.origin} were not approved.`,
      );
    }
    const originPermission = { origins: [`${url.origin}/*`] };
    const granted = await chrome.permissions.request(originPermission);
    if (!granted)
      throw new Error(`Host permission was not granted for ${url.origin}.`);
    approvedReferenceOrigins.add(url.origin);
  }
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(`External reference returned HTTP ${response.status}.`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_REMOTE_REFERENCE_BYTES
  ) {
    throw new Error("External reference exceeds the 5 MiB import limit.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_REMOTE_REFERENCE_BYTES) {
    throw new Error("External reference exceeds the 5 MiB import limit.");
  }
  return new TextDecoder().decode(bytes);
}

async function importCurrentHar(): Promise<void> {
  const har = await new Promise<chrome.devtools.network.HARLog>((resolve) => {
    chrome.devtools.network.getHAR(resolve);
  });
  importFileName.value = "current-network.har";
  importBaseUrl.value = "";
  importResources.clear();
  importText.value = JSON.stringify({ log: har }, null, 2);
  if (har.entries.length === 0) {
    importWarnings.value = [
      "No requests were captured. Reload the inspected page with DevTools open.",
    ];
  }
}

function prepareExport(): void {
  errorMessage.value = "";
  exportWarnings.value = [];
  exportDocuments.value = null;
  try {
    if (exportFormat.value === "xpanel-collection") {
      const result = exportCollectionFileWithWarnings(
        collections.value.map((collection) =>
          collectionRecordSchema.parse(collection),
        ),
        requests.value.map((request) => requestSpecV1Schema.parse(request)),
        { includeSensitive: includeSensitiveExport.value },
      );
      exportText.value = JSON.stringify(result.value, null, 2);
      exportWarnings.value = result.warnings.map((item) => item.message);
      exportExtension.value = "xpanel.collection.v1.json";
      exportMediaType.value = "application/json";
      return;
    }
    const sourceRequests =
      exportScope.value === "saved"
        ? requests.value.map((request) => requestSpecV1Schema.parse(request))
        : [requestSpecV1Schema.parse(current.value)];
    if (sourceRequests.length === 0)
      throw new Error("There are no saved requests to export.");
    const sourceIds = new Set(sourceRequests.map((request) => request.id));
    const sourceResponses = responses.value.filter((item) =>
      sourceIds.has(item.requestId),
    );
    const options = {
      includeSensitive: includeSensitiveExport.value,
      pretty: true,
      responses: sourceResponses,
    };

    if (exportFormat.value === "openapi" || exportFormat.value === "swagger") {
      const result =
        exportFormat.value === "openapi"
          ? exportOpenApi(sourceRequests, {
              ...options,
              version: openApiVersion.value,
            })
          : exportSwagger(sourceRequests, options);
      exportDocuments.value = result.documents;
      const documents = Object.values(result.documents);
      exportText.value =
        documents.length === 1
          ? serializeApiDocument(documents[0] ?? {})
          : apiDocumentEncoding.value === "json"
            ? JSON.stringify(result.documents, null, 2)
            : Object.entries(result.documents)
                .map(
                  ([name, document]) =>
                    `# ${name}\n${serializeApiDocument(document)}`,
                )
                .join("\n---\n");
      exportWarnings.value = result.warnings.map((item) => item.message);
      exportExtension.value =
        documents.length > 1 ? "zip" : apiDocumentEncoding.value;
      exportMediaType.value =
        documents.length > 1
          ? "application/zip"
          : apiDocumentEncoding.value === "json"
            ? "application/json"
            : "application/yaml";
      return;
    }

    if (exportFormat.value === "har" && sourceRequests.length > 1) {
      const result = exportHarWithWarnings(sourceRequests, sourceResponses, {
        includeSensitive: includeSensitiveExport.value,
      });
      exportText.value = JSON.stringify(result.value, null, 2);
      exportWarnings.value = result.warnings.map((item) => item.message);
      exportExtension.value = "har";
      exportMediaType.value = "application/json";
      return;
    }

    const results = sourceRequests.map((request) =>
      exportRequest(request, exportFormat.value, options),
    );
    const textResults = results.filter((result) => "text" in result);
    if (textResults.length !== results.length)
      throw new Error("Unexpected document export result.");
    exportText.value = textResults.map((result) => result.text).join("\n\n");
    const first = textResults[0];
    if (first) {
      exportExtension.value = first.extension;
      exportMediaType.value = first.mediaType;
    }
    exportWarnings.value = results.flatMap((result) =>
      result.warnings.map((item) => item.message),
    );
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

function serializeApiDocument(document: Record<string, unknown>): string {
  return apiDocumentEncoding.value === "json"
    ? `${JSON.stringify(document, null, 2)}\n`
    : stringifyYaml(document);
}

function changeSensitiveExport(event: Event): void {
  const input = event.target as HTMLInputElement;
  if (
    input.checked &&
    !window.confirm(
      "This export can contain credentials, cookies, private endpoints, and file metadata. Include sensitive values?",
    )
  ) {
    input.checked = false;
  }
  includeSensitiveExport.value = input.checked;
  prepareExport();
}

function openExport(): void {
  includeSensitiveExport.value = false;
  exportOpen.value = true;
  prepareExport();
}

function downloadExport(): void {
  const documents = Object.entries(exportDocuments.value ?? {});
  const useZip = documents.length > 1;
  let blob: Blob;
  if (useZip) {
    const archive = zipSync(
      Object.fromEntries(
        documents.map(([name, document]) => [
          apiDocumentEncoding.value === "yaml"
            ? name.replace(/\.json$/u, ".yaml")
            : name,
          strToU8(serializeApiDocument(document)),
        ]),
      ),
    );
    const archiveCopy = new Uint8Array(archive.byteLength);
    archiveCopy.set(archive);
    blob = new Blob([archiveCopy.buffer], { type: "application/zip" });
  } else {
    blob = new Blob([exportText.value], {
      type: `${exportMediaType.value};charset=utf-8`,
    });
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  const baseName =
    exportScope.value === "saved"
      ? "xpanel-saved-requests"
      : `xpanel-${current.value.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "request"}`;
  anchor.download = `${baseName}.${useZip ? "zip" : exportExtension.value}`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function toggleLocale(): void {
  locale.value = locale.value === "zh-CN" ? "en-US" : "zh-CN";
}

async function createCollection(): Promise<void> {
  const name = window.prompt("Collection name")?.trim();
  if (name) await store.createCollection(name);
}

function loadSaved(request: RequestSpecV1, collectionId?: string): void {
  store.loadRequest(request.id, collectionId);
}
</script>

<template>
  <main class="workbench-shell">
    <aside class="sidebar">
      <div class="brand-row">
        <div class="brand-mark">x</div>
        <div>
          <strong>xPanel</strong>
          <span>MV3 · local first</span>
        </div>
      </div>

      <Button
        class="w-full"
        type="button"
        :disabled="busy"
        @click="store.newRequest()"
      >
        <Plus :size="16" /> {{ $t("newRequest") }}
      </Button>

      <section class="sidebar-section">
        <h2>
          <span><Folder :size="15" /> {{ $t("collections") }}</span>
          <button
            class="icon-button"
            type="button"
            :disabled="busy"
            aria-label="New collection"
            @click="createCollection"
          >
            <Plus :size="14" />
          </button>
        </h2>
        <div
          v-for="collection in collections"
          :key="collection.id"
          class="collection-group"
        >
          <div class="collection-name">{{ collection.name }}</div>
          <button
            v-for="request in requests.filter((item) =>
              collection.requestIds.includes(item.id),
            )"
            :key="request.id"
            class="request-link"
            :data-active="request.id === current.id"
            type="button"
            :disabled="busy"
            @click="loadSaved(request, collection.id)"
          >
            <span class="method-mini">{{ request.method }}</span>
            <span>{{ request.name }}</span>
          </button>
        </div>
      </section>

      <section class="sidebar-section favorites">
        <h2><Heart :size="15" /> {{ $t("favorites") }}</h2>
        <button
          v-for="request in favorites"
          :key="request.id"
          class="request-link"
          type="button"
          :disabled="busy"
          @click="loadSaved(request)"
        >
          <span class="method-mini">{{ request.method }}</span>
          <span>{{ request.name }}</span>
        </button>
        <p v-if="favorites.length === 0" class="empty-note">
          {{ $t("noFavorites") }}
        </p>
      </section>

      <div class="sidebar-footer">
        <span><PanelLeft :size="14" /> {{ $t("devtoolsPanel") }}</span>
        <button
          class="icon-button"
          type="button"
          aria-label="Switch language"
          @click="toggleLocale"
        >
          <Languages :size="16" />
        </button>
      </div>
    </aside>

    <section class="workspace">
      <header class="toolbar">
        <input
          v-model="current.name"
          class="request-name"
          aria-label="Request name"
        />
        <select v-model="selectedCollectionId" aria-label="Save to collection">
          <option
            v-for="collection in collections"
            :key="collection.id"
            :value="collection.id"
          >
            {{ collection.name }}
          </option>
        </select>
        <div class="toolbar-actions">
          <button
            class="ghost-button"
            type="button"
            :disabled="busy"
            @click="importOpen = true"
          >
            <Upload :size="15" /> {{ $t("import") }}
          </button>
          <button class="ghost-button" type="button" @click="openExport">
            <Download :size="15" /> {{ $t("export") }}
          </button>
          <button
            class="ghost-button"
            type="button"
            @click="store.toggleFavorite()"
          >
            <Heart
              :size="15"
              :fill="current.favorite ? 'currentColor' : 'none'"
            />
            {{ $t("save") }}
          </button>
          <button
            class="ghost-button"
            type="button"
            @click="store.saveCurrent()"
          >
            <Save :size="15" /> {{ $t("saveRequest") }}
          </button>
        </div>
      </header>

      <div class="request-bar">
        <input
          :value="current.method"
          class="method-select"
          list="http-methods"
          aria-label="HTTP method"
          @input="updateMethod"
        />
        <datalist id="http-methods">
          <option
            v-for="method in [
              'GET',
              'POST',
              'PUT',
              'PATCH',
              'DELETE',
              'HEAD',
              'OPTIONS',
            ]"
            :key="method"
            :value="method"
          />
        </datalist>
        <input
          v-model="current.url"
          class="url-input"
          placeholder="https://api.example.com/v1/resource"
          aria-label="Request URL"
          @keyup.enter="send"
        />
        <button v-if="!busy" class="send-button" type="button" @click="send">
          <Play :size="16" fill="currentColor" /> {{ $t("send") }}
        </button>
        <button v-else class="stop-button" type="button" @click="stop">
          <Square :size="15" fill="currentColor" /> {{ $t("stop") }}
        </button>
      </div>

      <div
        v-if="notice || errorMessage"
        class="message-strip"
        :data-error="Boolean(errorMessage)"
      >
        {{ errorMessage || notice }}
      </div>

      <div class="split-pane">
        <section class="request-pane">
          <nav class="tab-list" aria-label="Request tabs">
            <button
              v-for="tab in [
                'params',
                'headers',
                'body',
                'auth',
                'options',
              ] as const"
              :key="tab"
              type="button"
              :data-active="requestTab === tab"
              @click="requestTab = tab"
            >
              {{ $t(tab) }}
              <span
                v-if="tab === 'params' && current.query.length"
                class="count"
                >{{ current.query.length }}</span
              >
              <span
                v-if="tab === 'headers' && current.headers.length"
                class="count"
                >{{ current.headers.length }}</span
              >
            </button>
          </nav>

          <div class="tab-content">
            <KeyValueEditor
              v-if="requestTab === 'params'"
              v-model="current.query"
              name-placeholder="Parameter"
            />
            <KeyValueEditor
              v-else-if="requestTab === 'headers'"
              v-model="current.headers"
              name-placeholder="Header"
            />
            <div v-else-if="requestTab === 'body'" class="body-editor">
              <div class="inline-controls">
                <select
                  :value="bodyKind"
                  @change="
                    setBodyKind(
                      ($event.target as HTMLSelectElement)
                        .value as BodySpec['kind'],
                    )
                  "
                >
                  <option value="none">None</option>
                  <option value="json">JSON</option>
                  <option value="text">Text</option>
                  <option value="file">File</option>
                  <option value="urlencoded">URL encoded</option>
                  <option value="multipart">Multipart</option>
                </select>
                <template v-if="bodyKind === 'json'">
                  <button
                    class="ghost-button"
                    type="button"
                    @click="beautifyBody"
                  >
                    <Braces :size="14" /> Pretty
                  </button>
                  <button
                    class="ghost-button"
                    type="button"
                    @click="compactBody"
                  >
                    Compact
                  </button>
                </template>
              </div>
              <textarea
                v-if="bodyKind === 'json' || bodyKind === 'text'"
                v-model="bodyText"
                class="code-editor"
                spellcheck="false"
                placeholder="Request body"
              />
              <KeyValueEditor
                v-else-if="current.body.kind === 'urlencoded'"
                v-model="current.body.entries"
                name-placeholder="Field"
              />
              <div
                v-else-if="current.body.kind === 'file'"
                class="file-option raw-file-option"
              >
                <span>Raw request body</span>
                <label class="file-picker ghost-button">
                  <FileInput :size="14" /> {{ current.body.file.name }}
                  <input type="file" @change="selectRawBodyFile" />
                </label>
                <input
                  v-model="current.body.mediaType"
                  class="field"
                  placeholder="Content type (optional)"
                />
              </div>
              <div
                v-else-if="current.body.kind === 'multipart'"
                class="multipart-editor"
              >
                <div class="inline-controls">
                  <button
                    class="ghost-button"
                    type="button"
                    @click="addMultipartText"
                  >
                    <Plus :size="14" /> Text field
                  </button>
                  <button
                    class="ghost-button"
                    type="button"
                    @click="addMultipartFile"
                  >
                    <FileInput :size="14" /> File
                  </button>
                </div>
                <div
                  v-for="(part, index) in current.body.parts"
                  :key="
                    part.kind === 'file'
                      ? part.file.id
                      : `${part.name}-${index}`
                  "
                  class="multipart-row"
                >
                  <input
                    v-model="part.enabled"
                    type="checkbox"
                    aria-label="Enable multipart part"
                  />
                  <input
                    v-model="part.name"
                    class="field"
                    placeholder="Field name"
                  />
                  <input
                    v-if="part.kind === 'text'"
                    v-model="part.value"
                    class="field"
                    placeholder="Value"
                  />
                  <label v-else class="file-picker ghost-button">
                    <FileInput :size="14" /> {{ part.file.name }}
                    <input
                      type="file"
                      @change="selectMultipartFile(index, $event)"
                    />
                  </label>
                  <button
                    class="icon-button"
                    type="button"
                    aria-label="Remove multipart part"
                    @click="removeMultipartPart(index)"
                  >
                    <X :size="14" />
                  </button>
                </div>
                <p v-if="current.body.parts.length === 0" class="empty-note">
                  Add text fields or choose files. Imported file paths are never
                  read automatically.
                </p>
              </div>
              <p v-else class="empty-note">This request has no body.</p>
            </div>
            <div v-else-if="requestTab === 'auth'" class="form-stack">
              <label>
                Authorization
                <select
                  :value="current.auth.kind"
                  @change="
                    setAuthKind(
                      ($event.target as HTMLSelectElement)
                        .value as AuthSpec['kind'],
                    )
                  "
                >
                  <option value="none">None</option>
                  <option value="basic">Basic</option>
                  <option value="bearer">Bearer token</option>
                  <option value="api-key">API key</option>
                  <option value="oauth2">OAuth 2 token</option>
                </select>
              </label>
              <template v-if="current.auth.kind === 'basic'">
                <input
                  v-model="current.auth.username"
                  class="field"
                  placeholder="Username"
                />
                <input
                  v-model="current.auth.password"
                  class="field"
                  type="password"
                  placeholder="Password"
                />
              </template>
              <input
                v-else-if="current.auth.kind === 'bearer'"
                v-model="current.auth.token"
                class="field"
                type="password"
                placeholder="Token"
              />
              <template v-else-if="current.auth.kind === 'api-key'">
                <select v-model="current.auth.location">
                  <option value="header">Header</option>
                  <option value="query">Query</option>
                  <option value="cookie" disabled>
                    Cookie (Browser unsupported)
                  </option>
                </select>
                <input
                  v-model="current.auth.name"
                  class="field"
                  placeholder="Name"
                />
                <input
                  v-model="current.auth.value"
                  class="field"
                  type="password"
                  placeholder="Value"
                />
              </template>
              <template v-else-if="current.auth.kind === 'oauth2'">
                <input
                  v-model="current.auth.tokenType"
                  class="field"
                  placeholder="Token type"
                />
                <input
                  v-model="current.auth.accessToken"
                  class="field"
                  type="password"
                  placeholder="Access token"
                />
              </template>
            </div>
            <div v-else class="form-stack options-grid">
              <label
                >Timeout (seconds)<input
                  :value="timeoutSecondsInput"
                  aria-label="Timeout (seconds)"
                  class="field"
                  type="number"
                  min="0.001"
                  max="86400"
                  step="0.001"
                  @focus="timeoutEditing = true"
                  @input="updateTimeoutInput"
                  @blur="normalizeTimeoutInput"
              /></label>
              <label
                >Redirect<select v-model="current.options.redirect">
                  <option value="follow">Follow</option>
                  <option value="manual">Manual</option>
                  <option value="error">Error</option>
                </select></label
              >
              <label
                >Cookies<select v-model="current.options.cookieMode">
                  <option value="include">Include</option>
                  <option value="same-origin">Same origin</option>
                  <option value="omit">Omit</option>
                </select></label
              >
              <div v-if="hasHiddenBrowserOptions" class="compatibility-note">
                <span>
                  Imported proxy, custom TLS, or multipart header options are
                  preserved for export, but Browser Fetch cannot send them.
                </span>
                <button
                  class="ghost-button"
                  type="button"
                  @click="clearHiddenBrowserOptions"
                >
                  Clear unsupported options
                </button>
              </div>
              <label class="check-row"
                ><input v-model="persistSensitive" type="checkbox" /> Persist
                sensitive values locally</label
              >
            </div>
          </div>
        </section>

        <section class="response-pane">
          <div class="response-heading">
            <div>
              <span class="eyebrow">{{ $t("response") }}</span>
              <strong
                v-if="response"
                :data-ok="response.status >= 200 && response.status < 400"
              >
                {{ response.status }} {{ response.statusText }}
              </strong>
              <span v-else>{{ $t("noResponse") }}</span>
            </div>
            <div v-if="response" class="response-meta">
              {{ Math.round(response.timings.durationMs) }} ms ·
              {{ response.body.sizeBytes }} B
            </div>
          </div>
          <ul v-if="response?.warnings.length" class="response-warning-list">
            <li
              v-for="warning in response.warnings"
              :key="`${warning.code}-${warning.path ?? ''}`"
            >
              {{ warning.message }}
            </li>
          </ul>
          <nav class="tab-list response-tabs">
            <button
              v-for="tab in ['pretty', 'raw', 'headers', 'timing'] as const"
              :key="tab"
              type="button"
              :data-active="responseTab === tab"
              @click="responseTab = tab"
            >
              {{ $t(tab) }}
            </button>
            <button
              class="copy-action"
              type="button"
              :disabled="!response"
              @click="copyText('body', responseRaw)"
            >
              <Check v-if="copied === 'body'" :size="14" />
              <Clipboard v-else :size="14" /> {{ $t("copyBody") }}
            </button>
            <button
              type="button"
              :disabled="!response"
              @click="copyText('response-headers', responseHeaders)"
            >
              <Check v-if="copied === 'response-headers'" :size="14" />
              <Clipboard v-else :size="14" /> Headers
            </button>
            <button
              type="button"
              :disabled="!response"
              @click="copyText('full-response', responseFull)"
            >
              <Check v-if="copied === 'full-response'" :size="14" />
              <Clipboard v-else :size="14" /> {{ $t("copyFull") }}
            </button>
          </nav>
          <div class="response-content">
            <div v-if="busy" class="response-empty">
              <LoaderCircle class="spin" :size="28" /> {{ $t("sending") }}
            </div>
            <pre v-else-if="response && responseTab === 'pretty'">{{
              responsePretty
            }}</pre>
            <pre v-else-if="response && responseTab === 'raw'">{{
              responseRaw
            }}</pre>
            <pre v-else-if="response && responseTab === 'headers'">{{
              responseHeaders
            }}</pre>
            <pre v-else-if="response && responseTab === 'timing'">{{
              responseTiming
            }}</pre>
            <div v-else class="response-empty">
              <Globe2 :size="30" /> {{ $t("sendHint") }}
            </div>
          </div>
        </section>
      </div>
    </section>

    <div
      v-if="importOpen"
      class="dialog-backdrop"
      @click.self="importOpen = false"
    >
      <section
        class="dialog-card"
        role="dialog"
        aria-modal="true"
        aria-label="Import requests"
      >
        <header>
          <div>
            <span class="eyebrow">{{ $t("universalImporter") }}</span>
            <h2>{{ $t("importRequests") }}</h2>
          </div>
          <button class="icon-button" type="button" @click="importOpen = false">
            <X :size="18" />
          </button>
        </header>
        <div class="dialog-actions">
          <button
            class="ghost-button"
            type="button"
            @click="fileInput?.click()"
          >
            <FileInput :size="15" /> {{ $t("chooseFiles") }}
          </button>
          <button class="ghost-button" type="button" @click="importCurrentHar">
            <Globe2 :size="15" /> {{ $t("currentHar") }}
          </button>
          <input
            ref="fileInput"
            hidden
            multiple
            type="file"
            accept=".txt,.json,.har,.yaml,.yml,.sh,.bash,.ps1,.js,.mjs,.cjs"
            @change="readImportFiles"
          />
          <span class="detected-format"
            >{{ $t("detected") }}: {{ detectedFormat }}</span
          >
        </div>
        <textarea
          v-model="importText"
          class="dialog-editor"
          spellcheck="false"
          placeholder="Paste cURL, PowerShell, fetch, HAR, OpenAPI, Swagger, or xPanel JSON…"
        />
        <ul v-if="importWarnings.length" class="warning-list">
          <li v-for="warning in importWarnings" :key="warning">
            {{ warning }}
          </li>
        </ul>
        <footer>
          <button
            class="ghost-button"
            type="button"
            @click="importOpen = false"
          >
            {{ $t("cancel") }}</button
          ><button
            class="primary-button"
            type="button"
            :disabled="!importText.trim()"
            @click="importRequests"
          >
            <Upload :size="15" /> {{ $t("import") }}
          </button>
        </footer>
      </section>
    </div>

    <div
      v-if="exportOpen"
      class="dialog-backdrop"
      @click.self="exportOpen = false"
    >
      <section
        class="dialog-card"
        role="dialog"
        aria-modal="true"
        aria-label="Export request"
      >
        <header>
          <div>
            <span class="eyebrow">{{ $t("safeByDefault") }}</span>
            <h2>{{ $t("exportRequests") }}</h2>
          </div>
          <button class="icon-button" type="button" @click="exportOpen = false">
            <X :size="18" />
          </button>
        </header>
        <div class="dialog-actions">
          <select v-model="exportFormat" @change="prepareExport">
            <option value="curl-bash">cURL (Bash)</option>
            <option value="powershell">PowerShell</option>
            <option value="fetch-node">Node fetch</option>
            <option value="har">HAR 1.2</option>
            <option value="openapi">OpenAPI 3</option>
            <option value="swagger">Swagger 2</option>
            <option value="xpanel-collection">xPanel collection</option>
          </select>
          <select v-model="exportScope" @change="prepareExport">
            <option value="current">{{ $t("currentRequest") }}</option>
            <option value="saved">{{ $t("savedRequests") }}</option>
          </select>
          <select
            v-if="exportFormat === 'openapi'"
            v-model="openApiVersion"
            @change="prepareExport"
          >
            <option value="3.0.3">OpenAPI 3.0.3</option>
            <option value="3.1.0">OpenAPI 3.1.0</option>
            <option value="3.2.0">OpenAPI 3.2.0</option>
          </select>
          <select
            v-if="exportFormat === 'openapi' || exportFormat === 'swagger'"
            v-model="apiDocumentEncoding"
            @change="prepareExport"
          >
            <option value="json">JSON</option>
            <option value="yaml">YAML</option>
          </select>
          <label class="check-row"
            ><input
              :checked="includeSensitiveExport"
              type="checkbox"
              @change="changeSensitiveExport"
            />
            {{ $t("includeSensitive") }}</label
          >
        </div>
        <textarea
          v-model="exportText"
          class="dialog-editor"
          spellcheck="false"
        />
        <ul v-if="exportWarnings.length" class="warning-list">
          <li v-for="warning in exportWarnings" :key="warning">
            {{ warning }}
          </li>
        </ul>
        <footer>
          <button
            class="ghost-button"
            type="button"
            @click="copyText('export', exportText)"
          >
            <Check v-if="copied === 'export'" :size="15" /><Clipboard
              v-else
              :size="15"
            />
            {{ $t("copy") }}</button
          ><button class="primary-button" type="button" @click="downloadExport">
            <Download :size="15" /> {{ $t("download") }}
          </button>
        </footer>
      </section>
    </div>
  </main>
</template>
