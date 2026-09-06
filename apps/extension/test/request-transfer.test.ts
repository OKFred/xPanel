import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDefaultRequest, type ResponseRecordV1 } from "@xpanel/contracts";

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
