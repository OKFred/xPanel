import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDefaultRequest, type ResponseRecordV1 } from "@xpanel/contracts";
import type { ExportFormat } from "@xpanel/request-core";

const database = vi.hoisted(() => ({
  loadWorkspace: vi.fn(async () => ({
    collections: [],
    requests: [],
    warnings: [],
  })),
  saveCollection: vi.fn(async () => undefined),
  saveRequest: vi.fn(async () => undefined),
  saveWorkspace: vi.fn(async () => undefined),
  deleteRequestFromWorkspace: vi.fn(async () => undefined),
  deleteCollectionFromWorkspace: vi.fn(async () => undefined),
}));

vi.mock("../src/lib/database", () => database);
vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

import {
  useRequestTransfer,
  type RequestTransferResponseBridge,
} from "../src/composables/useRequestTransfer";
import { useWorkbenchStore } from "../src/stores/workbench";

function responseFor(requestId: string, content: string): ResponseRecordV1 {
  return {
    requestId,
    executor: "browser",
    status: 201,
    statusText: "Created",
    headers: [{ name: "Content-Type", value: "text/plain", enabled: true }],
    body: {
      kind: "inline",
      encoding: "utf8",
      content,
      mediaType: "text/plain",
      sizeBytes: new TextEncoder().encode(content).byteLength,
    },
    timings: {
      startedAt: "2026-09-06T00:00:00.000Z",
      durationMs: 12,
    },
    redirects: [],
    warnings: [],
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe("export validation and preview ownership", () => {
  it("opens a blank draft with a local hint instead of a global URL exception", async () => {
    const errorMessage = ref("");
    const transfer = useRequestTransfer(errorMessage);
    await transfer.openExport();
    expect(transfer.exportOpen.value).toBe(true);
    expect(errorMessage.value).toBe("");
    expect(transfer.exportError.value).toBe("exportCurrentUrlMissing");
    expect(transfer.exportText.value).toBe("");
    expect(transfer.canExport.value).toBe(false);
    const createElement = vi.spyOn(document, "createElement");
    transfer.downloadExport();
    expect(createElement).not.toHaveBeenCalled();
    createElement.mockRestore();
  });

  it.each([
    "example.com/api",
    "/api/items",
    "{{baseUrl}}/api",
    "https://",
    "file:///tmp/request",
  ])(
    "rejects an incomplete or non-HTTP address without exposing it: %s",
    async (url) => {
      const transfer = useRequestTransfer(ref(""));
      useWorkbenchStore().current.url = url;
      await transfer.prepareExport();
      expect(transfer.exportError.value).toBe("exportCurrentUrlInvalid");
      expect(transfer.canExport.value).toBe(false);
    },
  );

  it.each<ExportFormat>([
    "curl-bash",
    "powershell",
    "fetch-node",
    "har",
    "openapi",
    "swagger",
  ])(
    "exports a valid request and clears the prior preview on failure: %s",
    async (format) => {
      const transfer = useRequestTransfer(ref(""));
      const store = useWorkbenchStore();
      transfer.exportFormat.value = format;
      store.current.url = "https://api.example.com/export";
      await transfer.prepareExport();
      expect(transfer.exportError.value).toBe("");
      expect(transfer.canExport.value).toBe(true);
      expect(transfer.exportText.value).not.toBe("");
      store.current.url = "https://";
      await transfer.prepareExport();
      expect(transfer.exportError.value).toBe("exportCurrentUrlInvalid");
      expect(transfer.exportText.value).toBe("");
      expect(transfer.canExport.value).toBe(false);
    },
  );

  it("exports saved requests despite an empty current draft, without silently skipping invalid saved items", async () => {
    const transfer = useRequestTransfer(ref(""));
    const store = useWorkbenchStore();
    store.requests = [
      createDefaultRequest({ url: "https://example.com/saved" }),
    ];
    transfer.exportScope.value = "saved";
    await transfer.prepareExport();
    expect(transfer.canExport.value).toBe(true);
    store.requests.push(createDefaultRequest());
    await transfer.prepareExport();
    expect(transfer.exportError.value).toBe("exportSavedUrlInvalid");
    expect(transfer.exportText.value).toBe("");
    expect(transfer.canExport.value).toBe(false);

    transfer.exportFormat.value = "xpanel-collection";
    await transfer.prepareExport();
    expect(transfer.exportError.value).toBe("");
    expect(transfer.canExport.value).toBe(true);
    expect(JSON.parse(transfer.exportText.value)).toMatchObject({
      requests: [{ url: "https://example.com/saved" }, { url: "" }],
    });
  });

  it("reports an empty saved scope inside the export dialog", async () => {
    const errorMessage = ref("");
    const transfer = useRequestTransfer(errorMessage);
    transfer.exportScope.value = "saved";
    await transfer.prepareExport();
    expect(transfer.exportError.value).toBe("noSavedRequests");
    expect(errorMessage.value).toBe("");
    expect(transfer.canExport.value).toBe(false);
  });

  it.each([false, true])(
    "ignores an obsolete response lookup (reject=%s)",
    async (reject) => {
      let resolveResponses!: (value: ResponseRecordV1[]) => void;
      let rejectResponses!: (error: Error) => void;
      const pendingResponses = new Promise<ResponseRecordV1[]>(
        (resolve, reject) => {
          resolveResponses = resolve;
          rejectResponses = reject;
        },
      );
      const transfer = useRequestTransfer(ref(""), {
        persistImportedResponses: async () => undefined,
        loadResponses: () => pendingResponses,
      });
      useWorkbenchStore().current.url = "https://example.com/export";
      transfer.exportFormat.value = "har";
      const pendingExport = transfer.prepareExport();
      expect(transfer.canExport.value).toBe(false);
      transfer.exportFormat.value = "curl-bash";
      await transfer.prepareExport();
      const currentPreview = transfer.exportText.value;
      if (reject) rejectResponses(new Error("Obsolete read failed"));
      else resolveResponses([]);
      await pendingExport;
      expect(transfer.exportText.value).toBe(currentPreview);
      expect(transfer.exportError.value).toBe("");
      expect(transfer.canExport.value).toBe(true);
    },
  );

  it("cannot restore sensitive data from an older export after reopening", async () => {
    let resolveResponses!: (value: ResponseRecordV1[]) => void;
    const transfer = useRequestTransfer(ref(""), {
      persistImportedResponses: async () => undefined,
      loadResponses: () =>
        new Promise((resolve) => {
          resolveResponses = resolve;
        }),
    });
    const store = useWorkbenchStore();
    store.current.url = "https://example.com/export";
    store.current.headers = [
      { name: "Authorization", value: "Bearer secret-canary", enabled: true },
    ];
    transfer.exportFormat.value = "har";
    transfer.includeSensitiveExport.value = true;
    const pendingExport = transfer.prepareExport();
    transfer.exportFormat.value = "curl-bash";
    await transfer.openExport();
    resolveResponses([]);
    await pendingExport;
    expect(transfer.includeSensitiveExport.value).toBe(false);
    expect(transfer.exportText.value).not.toContain("secret-canary");
    expect(transfer.exportText.value).toContain("curl");
  });
});

describe("request transfer response bridge", () => {
  it("persists imported responses after the store remaps request ids", async () => {
    const persistImportedResponses = vi.fn<
      RequestTransferResponseBridge["persistImportedResponses"]
    >(async () => undefined);
    const loadResponses = vi.fn<RequestTransferResponseBridge["loadResponses"]>(
      async () => [],
    );
    const bridge: RequestTransferResponseBridge = {
      persistImportedResponses,
      loadResponses,
    };
    const errorMessage = ref("");
    const transfer = useRequestTransfer(errorMessage, bridge);
    transfer.importText.value = JSON.stringify({
      log: {
        version: "1.2",
        creator: { name: "Chrome", version: "1" },
        entries: [
          {
            startedDateTime: "2026-09-06T00:00:00.000Z",
            time: 12,
            request: {
              method: "GET",
              url: "https://api.example.com/items",
              httpVersion: "HTTP/2",
              headers: [],
              queryString: [],
            },
            response: {
              status: 201,
              statusText: "Created",
              headers: [{ name: "Content-Type", value: "text/plain" }],
              content: {
                size: 22,
                mimeType: "text/plain",
                text: "bridge-import-response",
              },
              redirectURL: "",
            },
            cache: {},
            timings: {
              blocked: 0,
              dns: 0,
              connect: 0,
              ssl: 0,
              send: 0,
              wait: 10,
              receive: 2,
            },
          },
        ],
      },
    });

    await transfer.importRequests();

    const store = useWorkbenchStore();
    expect(persistImportedResponses).toHaveBeenCalledOnce();
    const persisted = persistImportedResponses.mock.calls[0]?.[0];
    expect(persisted).toHaveLength(1);
    expect(persisted?.[0]?.requestId).toBe(store.current.id);
    expect(persisted?.[0]?.body.content).toBe("bridge-import-response");
    expect(store.current.id).not.toBe("");
    expect(store.$state).not.toHaveProperty("responses");
  });

  it("hydrates response-inclusive exports without placing bodies in Pinia", async () => {
    const request = createDefaultRequest({
      id: "export-request",
      name: "Export request",
      url: "https://api.example.com/export",
    });
    const response = responseFor(request.id, "bridge-export-response");
    const persistImportedResponses = vi.fn<
      RequestTransferResponseBridge["persistImportedResponses"]
    >(async () => undefined);
    const loadResponses = vi.fn<RequestTransferResponseBridge["loadResponses"]>(
      async () => [response],
    );
    const bridge: RequestTransferResponseBridge = {
      persistImportedResponses,
      loadResponses,
    };
    const errorMessage = ref("");
    const transfer = useRequestTransfer(errorMessage, bridge);
    const store = useWorkbenchStore();
    store.current = request;
    transfer.exportFormat.value = "har";
    transfer.includeSensitiveExport.value = true;

    await transfer.prepareExport();

    expect(errorMessage.value).toBe("");
    expect(loadResponses).toHaveBeenCalledOnce();
    expect(loadResponses).toHaveBeenCalledWith(new Set([request.id]));
    expect(transfer.exportText.value).toContain("bridge-export-response");
    expect(JSON.stringify(store.$state)).not.toContain(
      "bridge-export-response",
    );
  });
});
