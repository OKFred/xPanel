import { ref, type Ref } from "vue";

import type { CollectionRecord, RequestSpecV1 } from "@xpanel/contracts";

import type { DeleteTarget } from "../components/dialog/delete-target";
import { useWorkbenchStore } from "../stores/workbench";

interface CollectionActionOptions {
  busy: Ref<boolean>;
  collections: Ref<CollectionRecord[]>;
  current: Ref<RequestSpecV1>;
  displayCollectionName: (collection: CollectionRecord) => string;
  locale: Ref<string>;
  requests: Ref<RequestSpecV1[]>;
  showLatestForRequest: (requestId: string) => Promise<void>;
  t: (key: string) => string;
}

export function useWorkbenchCollectionActions(
  options: CollectionActionOptions,
) {
  const store = useWorkbenchStore();
  const deleteTarget = ref<DeleteTarget | null>(null);
  const deleteCollectionRequests = ref(false);
  const deleteBusy = ref(false);
  const deleteError = ref("");

  function toggleLocale(): void {
    options.locale.value = options.locale.value === "zh-CN" ? "en-US" : "zh-CN";
  }

  async function createCollection(): Promise<void> {
    const name = window.prompt(options.t("collectionName"))?.trim();
    if (name) await store.createCollection(name);
  }

  function createNewRequest(): void {
    store.newRequest();
    void options.showLatestForRequest(options.current.value.id);
  }

  function loadSaved(request: RequestSpecV1, collectionId?: string): void {
    store.loadRequest(request.id, collectionId);
    void options.showLatestForRequest(request.id);
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
    const savedRequestIds = new Set(
      options.requests.value.map((request) => request.id),
    );
    const collectionRequestIds = [
      ...new Set(
        collection.requestIds.filter((requestId) =>
          savedRequestIds.has(requestId),
        ),
      ),
    ];
    const sharedRequestCount = collectionRequestIds.filter((requestId) =>
      options.collections.value.some(
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
      name: options.displayCollectionName(collection),
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
    if (!target || options.busy.value || deleteBusy.value) return;
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
      await options.showLatestForRequest(options.current.value.id);
    } catch (error) {
      deleteError.value =
        error instanceof Error ? error.message : options.t("deleteFailed");
    } finally {
      deleteBusy.value = false;
    }
  }

  return {
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
  };
}
