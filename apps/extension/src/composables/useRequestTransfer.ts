import { strToU8, zipSync } from "fflate";
import { storeToRefs } from "pinia";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { stringify as stringifyYaml } from "yaml";

import {
  detectImportFormat,
  exportCollectionFileWithWarnings,
  exportHarWithWarnings,
  exportOpenApi,
  exportRequest,
  exportSwagger,
  parseImport,
  type ExportFormat,
} from "@xpanel/request-core";
import {
  collectionRecordSchema,
  requestSpecV1Schema,
  responseRecordV1Schema,
  type ResponseRecordV1,
} from "@xpanel/contracts";

import { useWorkbenchStore } from "../stores/workbench";

const MAX_REMOTE_REFERENCE_BYTES = 5 * 1024 * 1024;

export interface RequestTransferResponseBridge {
  persistImportedResponses(responses: ResponseRecordV1[]): Promise<void>;
  loadResponses(requestIds: ReadonlySet<string>): Promise<ResponseRecordV1[]>;
}

const defaultResponseBridge: RequestTransferResponseBridge = {
  persistImportedResponses: () => Promise.resolve(),
  loadResponses: () => Promise.resolve([]),
};

function formatIncludesResponses(format: ExportFormat): boolean {
  return format === "har" || format === "openapi" || format === "swagger";
}

export function useRequestTransfer(
  errorMessage: { value: string },
  responseBridge: RequestTransferResponseBridge = defaultResponseBridge,
) {
  const store = useWorkbenchStore();
  const { collections, current, notice, requests } = storeToRefs(store);
  const { t } = useI18n();
  const importOpen = ref(false);
  const exportOpen = ref(false);
  const importText = ref("");
  const importFileName = ref("");
  const importBaseUrl = ref("");
  const importWarnings = ref<string[]>([]);
  const importResources = new Map<string, string>();
  const approvedReferenceOrigins = new Set<string>();
  const exportFormat = ref<ExportFormat>("curl-bash");
  const exportScope = ref<"current" | "saved">("current");
  const openApiVersion = ref<"3.0.3" | "3.1.0" | "3.2.0">("3.1.0");
  const apiDocumentEncoding = ref<"json" | "yaml">("json");
  const exportText = ref("");
  const exportError = ref("");
  const exportReady = ref(false);
  const canExport = computed(
    () => exportReady.value && exportText.value.trim().length > 0,
  );
  let exportRevision = 0;
  const exportWarnings = ref<string[]>([]);
  const includeSensitiveExport = ref(false);
  const exportDocuments = ref<Record<string, Record<string, unknown>> | null>(
    null,
  );
  const exportExtension = ref("txt");
  const exportMediaType = ref("text/plain");
  const detectedFormat = computed(() =>
    detectImportFormat(importText.value, importFileName.value),
  );

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
      const importedResponses = await store.addImported(
        result.requests,
        result.collections,
        result.responses,
      );
      await responseBridge.persistImportedResponses(importedResponses);
      importOpen.value = false;
      if (importWarnings.value.length > 0) {
        notice.value = t("importedWithWarnings", {
          count: importWarnings.value.length,
        });
      }
    } catch (error) {
      errorMessage.value =
        error instanceof Error ? error.message : String(error);
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
      if (local === undefined) {
        throw new Error(`Select the referenced local file: ${url.pathname}`);
      }
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
      if (!granted) {
        throw new Error(`Host permission was not granted for ${url.origin}.`);
      }
      approvedReferenceOrigins.add(url.origin);
    }
    const response = await fetch(url, {
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
    if (!response.ok) {
      throw new Error(`External reference returned HTTP ${response.status}.`);
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_REMOTE_REFERENCE_BYTES
    ) {
      throw new Error(t("externalRefTooLarge"));
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_REMOTE_REFERENCE_BYTES) {
      throw new Error(t("externalRefTooLarge"));
    }
    return new TextDecoder().decode(bytes);
  }

  async function importCurrentHar(): Promise<void> {
    if (typeof chrome.devtools?.network?.getHAR !== "function") return;
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

  async function prepareExport(): Promise<void> {
    const revision = ++exportRevision;
    const format = exportFormat.value;
    const includeSensitive = includeSensitiveExport.value;
    const version = openApiVersion.value;
    errorMessage.value = "";
    exportError.value = "";
    exportReady.value = false;
    exportText.value = "";
    exportWarnings.value = [];
    exportDocuments.value = null;
    try {
      if (format === "xpanel-collection") {
        const result = exportCollectionFileWithWarnings(
          collections.value.map((collection) =>
            collectionRecordSchema.parse(collection),
          ),
          requests.value.map((request) => requestSpecV1Schema.parse(request)),
          { includeSensitive },
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
      if (sourceRequests.length === 0) throw new Error(t("noSavedRequests"));
      const invalidIndex = sourceRequests.findIndex((request) => {
        try {
          const url = new URL(request.url);
          return url.protocol !== "http:" && url.protocol !== "https:";
        } catch {
          return true;
        }
      });
      if (invalidIndex !== -1) {
        exportError.value =
          exportScope.value === "saved"
            ? t("exportSavedUrlInvalid", { index: invalidIndex + 1 })
            : t(
                current.value.url.trim()
                  ? "exportCurrentUrlInvalid"
                  : "exportCurrentUrlMissing",
              );
        return;
      }
      const sourceIds = new Set(sourceRequests.map((request) => request.id));
      const sourceResponses = formatIncludesResponses(format)
        ? (await responseBridge.loadResponses(sourceIds))
            .map((response) => responseRecordV1Schema.parse(response))
            .filter((response) => sourceIds.has(response.requestId))
        : [];
      if (revision !== exportRevision) return;
      const options = {
        includeSensitive,
        pretty: true,
        responses: sourceResponses,
      };

      if (format === "openapi" || format === "swagger") {
        const result =
          format === "openapi"
            ? exportOpenApi(sourceRequests, {
                ...options,
                version,
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

      if (format === "har" && sourceRequests.length > 1) {
        const result = exportHarWithWarnings(sourceRequests, sourceResponses, {
          includeSensitive,
        });
        exportText.value = JSON.stringify(result.value, null, 2);
        exportWarnings.value = result.warnings.map((item) => item.message);
        exportExtension.value = "har";
        exportMediaType.value = "application/json";
        return;
      }

      const results = sourceRequests.map((request) =>
        exportRequest(request, format, options),
      );
      const textResults = results.filter((result) => "text" in result);
      if (textResults.length !== results.length) {
        throw new Error(t("unexpectedDocumentExport"));
      }
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
      if (revision === exportRevision) {
        exportText.value = "";
        exportDocuments.value = null;
        exportError.value =
          error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (revision === exportRevision) {
        exportReady.value = !exportError.value && exportText.value.length > 0;
      }
    }
  }

  function serializeApiDocument(document: Record<string, unknown>): string {
    return apiDocumentEncoding.value === "json"
      ? `${JSON.stringify(document, null, 2)}\n`
      : stringifyYaml(document);
  }

  async function changeSensitiveExport(event: Event): Promise<void> {
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
    await prepareExport();
  }

  async function openExport(): Promise<void> {
    includeSensitiveExport.value = false;
    exportOpen.value = true;
    await prepareExport();
  }

  function downloadExport(): void {
    if (!canExport.value) return;
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

  return {
    apiDocumentEncoding,
    canExport,
    changeSensitiveExport,
    detectedFormat,
    downloadExport,
    exportError,
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
  };
}
