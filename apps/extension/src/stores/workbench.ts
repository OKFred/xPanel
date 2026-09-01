import { defineStore } from "pinia";

import {
  createDefaultRequest,
  redactRequest,
  type CollectionRecord,
  type FileReferenceV1,
  type RequestSpecV1,
  type ResponseRecordV1,
} from "@xpanel/contracts";

import {
  loadWorkspace,
  saveCollection,
  saveRequest,
  saveWorkspace,
} from "../lib/database";

const DEFAULT_COLLECTION_ID = "collection-default";

function now(): string {
  return new Date().toISOString();
}

function defaultCollection(): CollectionRecord {
  const timestamp = now();
  return {
    id: DEFAULT_COLLECTION_ID,
    name: "My requests",
    description: "Requests saved from the xPanel workbench.",
    requestIds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function resetImportedFileReference(
  reference: FileReferenceV1,
): FileReferenceV1 {
  const rest = structuredClone(reference);
  delete rest.pathHint;
  return {
    ...rest,
    id: crypto.randomUUID(),
    requiresReselection: true,
  };
}

function resetImportedFiles(request: RequestSpecV1): RequestSpecV1 {
  const reset = structuredClone(request);
  if (reset.body.kind === "file") {
    reset.body.file = resetImportedFileReference(reset.body.file);
  }
  if (reset.body.kind === "multipart") {
    reset.body.parts = reset.body.parts.map((part) =>
      part.kind === "file"
        ? { ...part, file: resetImportedFileReference(part.file) }
        : part,
    );
  }
  if (reset.options.tls.caFile) {
    reset.options.tls.caFile = resetImportedFileReference(
      reset.options.tls.caFile,
    );
  }
  if (reset.options.tls.clientCertificate) {
    reset.options.tls.clientCertificate = {
      ...reset.options.tls.clientCertificate,
      certificate: resetImportedFileReference(
        reset.options.tls.clientCertificate.certificate,
      ),
      privateKey: resetImportedFileReference(
        reset.options.tls.clientCertificate.privateKey,
      ),
    };
  }
  return reset;
}

function remapImportedWorkspace(
  requests: RequestSpecV1[],
  collections: CollectionRecord[],
): {
  requests: RequestSpecV1[];
  collections: CollectionRecord[];
  requestIds: Map<string, string>;
} {
  const timestamp = now();
  const requestIds = new Map<string, string>();
  const remappedRequests = requests.map((request) => {
    const id = crypto.randomUUID();
    requestIds.set(request.id, id);
    return { ...resetImportedFiles(request), id };
  });
  const remappedCollections = collections.map((collection) => ({
    ...structuredClone(collection),
    id: crypto.randomUUID(),
    requestIds: collection.requestIds
      .map((requestId) => requestIds.get(requestId))
      .filter((requestId): requestId is string => requestId !== undefined),
    createdAt: timestamp,
    updatedAt: timestamp,
  }));

  if (remappedCollections.length === 0 && remappedRequests.length > 0) {
    remappedCollections.push({
      id: crypto.randomUUID(),
      name: `Imported ${new Date().toLocaleString()}`,
      description: "Imported into a new xPanel collection.",
      requestIds: remappedRequests.map((request) => request.id),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  return {
    requests: remappedRequests,
    collections: remappedCollections,
    requestIds,
  };
}

export const useWorkbenchStore = defineStore("workbench", {
  state: () => ({
    current: createDefaultRequest(),
    response: null as ResponseRecordV1 | null,
    responses: [] as ResponseRecordV1[],
    requests: [] as RequestSpecV1[],
    collections: [] as CollectionRecord[],
    busy: false,
    initialized: false,
    notice: "",
    persistSensitive: false,
    selectedCollectionId: DEFAULT_COLLECTION_ID,
  }),
  getters: {
    favorites: (state): RequestSpecV1[] =>
      state.requests.filter((request) => request.favorite),
  },
  actions: {
    async initialize(): Promise<void> {
      if (this.initialized) return;
      const workspace = await loadWorkspace();
      this.collections = workspace.collections;
      this.requests = workspace.requests;
      if (workspace.warnings.length > 0) {
        this.notice = `${workspace.warnings.length} invalid saved record(s) were ignored. Import a backup if data is missing.`;
      }
      if (this.collections.length === 0) {
        const collection = defaultCollection();
        this.collections = [collection];
        await saveCollection(collection);
      }
      this.selectedCollectionId =
        this.collections[0]?.id ?? DEFAULT_COLLECTION_ID;
      this.initialized = true;
    },
    newRequest(): void {
      this.current = createDefaultRequest();
      this.response = null;
    },
    loadRequest(id: string, collectionId?: string): void {
      const request = this.requests.find((candidate) => candidate.id === id);
      if (request) {
        if (collectionId) this.selectedCollectionId = collectionId;
        this.current = structuredClone(request);
        this.response =
          structuredClone(
            this.responses.find((response) => response.requestId === id),
          ) ?? null;
      }
    },
    async createCollection(name: string): Promise<void> {
      const timestamp = now();
      const collection: CollectionRecord = {
        id: crypto.randomUUID(),
        name,
        description: "",
        requestIds: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.collections.push(collection);
      this.selectedCollectionId = collection.id;
      await saveCollection(collection);
    },
    setResponse(response: ResponseRecordV1): void {
      const index = this.responses.findIndex(
        (candidate) => candidate.requestId === response.requestId,
      );
      if (index >= 0)
        this.responses.splice(index, 1, structuredClone(response));
      else this.responses.push(structuredClone(response));
      this.response = response;
    },
    async saveCurrent(): Promise<void> {
      const request = this.persistSensitive
        ? structuredClone(this.current)
        : redactRequest(this.current);
      const existingIndex = this.requests.findIndex(
        (candidate) => candidate.id === request.id,
      );
      if (existingIndex >= 0) this.requests.splice(existingIndex, 1, request);
      else this.requests.push(request);

      let collection = this.collections.find(
        (candidate) => candidate.id === this.selectedCollectionId,
      );
      collection ??= defaultCollection();
      if (!collection.requestIds.includes(request.id))
        collection.requestIds.push(request.id);
      collection.updatedAt = now();
      const collectionIndex = this.collections.findIndex(
        (candidate) => candidate.id === collection.id,
      );
      if (collectionIndex >= 0)
        this.collections.splice(collectionIndex, 1, collection);
      else this.collections.push(collection);

      await Promise.all([saveRequest(request), saveCollection(collection)]);
      this.notice = this.persistSensitive
        ? "Saved locally with sensitive values."
        : "Saved locally with sensitive values redacted.";
    },
    async toggleFavorite(): Promise<void> {
      this.current.favorite = !this.current.favorite;
      await this.saveCurrent();
    },
    async addImported(
      requests: RequestSpecV1[],
      collections: CollectionRecord[],
      responses: ResponseRecordV1[] = [],
    ): Promise<void> {
      const imported = remapImportedWorkspace(requests, collections);
      const storedRequests = this.persistSensitive
        ? imported.requests.map((request) => structuredClone(request))
        : imported.requests.map(redactRequest);

      this.requests.push(...storedRequests);
      this.collections.push(...imported.collections);
      if (imported.collections[0])
        this.selectedCollectionId = imported.collections[0].id;
      const importedResponses = responses.flatMap((response) => {
        const requestId = imported.requestIds.get(response.requestId);
        return requestId ? [{ ...structuredClone(response), requestId }] : [];
      });
      this.responses.push(...importedResponses);
      await saveWorkspace(this.collections, this.requests);
      if (imported.requests[0]) {
        this.current = structuredClone(imported.requests[0]);
        this.response =
          structuredClone(
            importedResponses.find(
              (response) => response.requestId === imported.requests[0]?.id,
            ),
          ) ?? null;
      }
      this.notice = `Imported ${requests.length} request${requests.length === 1 ? "" : "s"}.`;
    },
  },
});
