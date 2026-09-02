import { defineStore } from "pinia";

import {
  collectionRecordSchema,
  createDefaultRequest,
  redactRequest,
  requestSpecV1Schema,
  responseRecordV1Schema,
  type CollectionRecord,
  type FileReferenceV1,
  type RequestSpecV1,
  type ResponseRecordV1,
} from "@xpanel/contracts";

import {
  deleteCollectionFromWorkspace,
  deleteRequestFromWorkspace,
  loadWorkspace,
  saveCollection,
  saveRequest,
  saveWorkspace,
} from "../lib/database";

const DEFAULT_COLLECTION_ID = "collection-default";

function now(): string {
  return new Date().toISOString();
}

function defaultCollection(id = DEFAULT_COLLECTION_ID): CollectionRecord {
  const timestamp = now();
  return {
    id,
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
  const rest = { ...reference };
  delete rest.pathHint;
  return {
    ...rest,
    id: crypto.randomUUID(),
    requiresReselection: true,
  };
}

function fallbackRequest(
  requests: RequestSpecV1[],
  collections: CollectionRecord[],
  selectedCollectionId: string,
): RequestSpecV1 | undefined {
  const selected = collections.find(
    (collection) => collection.id === selectedCollectionId,
  );
  return (
    selected?.requestIds
      .map((id) => requests.find((request) => request.id === id))
      .find((request): request is RequestSpecV1 => request !== undefined) ??
    requests[0]
  );
}

function cloneRequest(request: RequestSpecV1): RequestSpecV1 {
  return requestSpecV1Schema.parse(request);
}

function cloneResponse(
  response: ResponseRecordV1 | undefined,
): ResponseRecordV1 | null {
  return response ? responseRecordV1Schema.parse(response) : null;
}

function resetImportedFiles(request: RequestSpecV1): RequestSpecV1 {
  const reset = cloneRequest(request);
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
    ...collectionRecordSchema.parse(collection),
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
        this.current = cloneRequest(request);
        this.response = cloneResponse(
          this.responses.find((response) => response.requestId === id),
        );
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
    async deleteRequest(id: string): Promise<void> {
      const timestamp = now();
      const nextRequests = this.requests.filter((request) => request.id !== id);
      const nextCollections = this.collections.map((collection) => {
        if (!collection.requestIds.includes(id)) return collection;
        return {
          ...collection,
          requestIds: collection.requestIds.filter(
            (requestId) => requestId !== id,
          ),
          updatedAt: timestamp,
        };
      });

      await deleteRequestFromWorkspace(id, nextCollections);

      const nextResponses = this.responses.filter(
        (response) => response.requestId !== id,
      );
      this.requests = nextRequests;
      this.collections = nextCollections;
      this.responses = nextResponses;
      if (this.current.id === id) {
        const fallback = fallbackRequest(
          nextRequests,
          nextCollections,
          this.selectedCollectionId,
        );
        this.current = fallback
          ? cloneRequest(fallback)
          : createDefaultRequest();
        this.response = cloneResponse(
          nextResponses.find(
            (response) => response.requestId === this.current.id,
          ),
        );
      } else if (this.response?.requestId === id) {
        this.response = null;
      }
      this.notice = "Deleted saved request.";
    },
    async deleteCollection(id: string, cascadeRequests = false): Promise<void> {
      const target = this.collections.find(
        (collection) => collection.id === id,
      );
      if (!target) return;

      const timestamp = now();
      const remainingCollections = this.collections.filter(
        (collection) => collection.id !== id,
      );
      const remainingReferences = new Set(
        remainingCollections.flatMap((collection) => collection.requestIds),
      );
      const existingRequestIds = new Set(
        this.requests.map((request) => request.id),
      );
      const exclusiveRequestIds = [
        ...new Set(
          target.requestIds.filter(
            (requestId) =>
              existingRequestIds.has(requestId) &&
              !remainingReferences.has(requestId),
          ),
        ),
      ];
      const requestIdsToDelete = cascadeRequests ? exclusiveRequestIds : [];
      const deletedRequestIds = new Set(requestIdsToDelete);
      let nextCollections = remainingCollections;

      if (!cascadeRequests) {
        if (exclusiveRequestIds.length > 0) {
          let fallbackIndex = nextCollections.findIndex(
            (collection) =>
              collection.id === DEFAULT_COLLECTION_ID ||
              collection.name === "My requests",
          );
          if (fallbackIndex < 0) {
            const fallbackId =
              id === DEFAULT_COLLECTION_ID
                ? crypto.randomUUID()
                : DEFAULT_COLLECTION_ID;
            nextCollections = [
              ...nextCollections,
              defaultCollection(fallbackId),
            ];
            fallbackIndex = nextCollections.length - 1;
          }
          const fallback = nextCollections[fallbackIndex]!;
          nextCollections.splice(fallbackIndex, 1, {
            ...fallback,
            requestIds: [
              ...new Set([...fallback.requestIds, ...exclusiveRequestIds]),
            ],
            updatedAt: timestamp,
          });
        }
      }

      if (nextCollections.length === 0) {
        const fallbackId =
          id === DEFAULT_COLLECTION_ID
            ? crypto.randomUUID()
            : DEFAULT_COLLECTION_ID;
        nextCollections = [defaultCollection(fallbackId)];
      }

      await deleteCollectionFromWorkspace(
        id,
        nextCollections,
        requestIdsToDelete,
      );

      const nextRequests = cascadeRequests
        ? this.requests.filter((request) => !deletedRequestIds.has(request.id))
        : this.requests;
      const nextResponses = cascadeRequests
        ? this.responses.filter(
            (response) => !deletedRequestIds.has(response.requestId),
          )
        : this.responses;
      this.collections = nextCollections;
      this.requests = nextRequests;
      this.responses = nextResponses;
      if (
        !nextCollections.some(
          (collection) => collection.id === this.selectedCollectionId,
        )
      ) {
        this.selectedCollectionId =
          nextCollections.find((collection) =>
            collection.requestIds.includes(this.current.id),
          )?.id ??
          (!cascadeRequests && exclusiveRequestIds.length > 0
            ? nextCollections.find(
                (collection) =>
                  collection.id === DEFAULT_COLLECTION_ID ||
                  collection.name === "My requests",
              )?.id
            : undefined) ??
          nextCollections[0]!.id;
      }
      if (deletedRequestIds.has(this.current.id)) {
        const fallback = fallbackRequest(
          nextRequests,
          nextCollections,
          this.selectedCollectionId,
        );
        this.current = fallback
          ? cloneRequest(fallback)
          : createDefaultRequest();
        this.response = cloneResponse(
          nextResponses.find(
            (response) => response.requestId === this.current.id,
          ),
        );
      } else if (
        this.response &&
        deletedRequestIds.has(this.response.requestId)
      ) {
        this.response = null;
      }
      this.notice = cascadeRequests
        ? `Deleted collection and ${requestIdsToDelete.length} exclusive request${requestIdsToDelete.length === 1 ? "" : "s"}; shared requests were kept.`
        : exclusiveRequestIds.length > 0
          ? "Deleted collection; its exclusive requests were moved to My requests."
          : target.requestIds.some((requestId) =>
                remainingReferences.has(requestId),
              )
            ? "Deleted collection; shared requests were kept."
            : "Deleted collection.";
    },
    setResponse(response: ResponseRecordV1): void {
      const storedResponse = responseRecordV1Schema.parse(response);
      const index = this.responses.findIndex(
        (candidate) => candidate.requestId === storedResponse.requestId,
      );
      if (index >= 0) this.responses.splice(index, 1, storedResponse);
      else this.responses.push(storedResponse);
      this.response = storedResponse;
    },
    async saveCurrent(): Promise<void> {
      const request = this.persistSensitive
        ? cloneRequest(this.current)
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
        ? imported.requests.map(cloneRequest)
        : imported.requests.map(redactRequest);

      this.requests.push(...storedRequests);
      this.collections.push(...imported.collections);
      if (imported.collections[0])
        this.selectedCollectionId = imported.collections[0].id;
      const importedResponses = responses.flatMap((response) => {
        const requestId = imported.requestIds.get(response.requestId);
        return requestId
          ? [{ ...responseRecordV1Schema.parse(response), requestId }]
          : [];
      });
      this.responses.push(...importedResponses);
      await saveWorkspace(this.collections, this.requests);
      if (imported.requests[0]) {
        this.current = cloneRequest(imported.requests[0]);
        this.response = cloneResponse(
          importedResponses.find(
            (response) => response.requestId === imported.requests[0]?.id,
          ),
        );
      }
      this.notice = `Imported ${requests.length} request${requests.length === 1 ? "" : "s"}.`;
    },
  },
});
