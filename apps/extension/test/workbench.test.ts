import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDefaultRequest,
  REDACTED_VALUE,
  type CollectionRecord,
} from "@xpanel/contracts";

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

import { useWorkbenchStore } from "../src/stores/workbench";

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe("workbench persistence boundaries", () => {
  it("imports into new ids while persisting only a redacted copy", async () => {
    const store = useWorkbenchStore();
    await store.initialize();
    const request = createDefaultRequest({
      id: "source-request",
      url: "https://user:password@example.com/upload?session=secret",
      auth: { kind: "bearer", token: "secret-token" },
      body: {
        kind: "file",
        file: {
          id: "source-file",
          name: "payload.bin",
          pathHint: "C:\\private\\payload.bin",
          requiresReselection: false,
        },
      },
    });
    const timestamp = new Date().toISOString();
    const collection: CollectionRecord = {
      id: "source-collection",
      name: "Imported",
      description: "",
      requestIds: [request.id],
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await store.addImported([request], [collection]);

    expect(store.requests).toHaveLength(1);
    expect(store.requests[0]?.id).not.toBe(request.id);
    expect(store.collections.at(-1)?.id).not.toBe(collection.id);
    expect(store.collections.at(-1)?.requestIds).toEqual([
      store.requests[0]?.id,
    ]);
    expect(store.requests[0]?.auth).toEqual({
      kind: "bearer",
      token: REDACTED_VALUE,
    });
    expect(store.requests[0]?.url).not.toContain("password");
    expect(store.current.auth).toEqual({
      kind: "bearer",
      token: "secret-token",
    });
    expect(store.current.body.kind).toBe("file");
    if (store.current.body.kind === "file") {
      expect(store.current.body.file.id).not.toBe("source-file");
      expect(store.current.body.file.pathHint).toBeUndefined();
      expect(store.current.body.file.requiresReselection).toBe(true);
    }
    expect(database.saveWorkspace).toHaveBeenCalledOnce();
  });

  it("atomically deletes a request from every collection and selects a fallback", async () => {
    const store = useWorkbenchStore();
    const deleted = createDefaultRequest({
      id: "request-deleted",
      name: "Deleted",
    });
    const fallback = createDefaultRequest({
      id: "request-fallback",
      name: "Fallback",
    });
    const timestamp = new Date().toISOString();
    const collection: CollectionRecord = {
      id: "collection-one",
      name: "One",
      description: "",
      requestIds: [deleted.id, fallback.id],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const response = (requestId: string) => ({
      requestId,
      executor: "browser" as const,
      status: 200,
      statusText: "OK",
      headers: [],
      body: {
        kind: "inline" as const,
        encoding: "utf8" as const,
        content: "ok",
        sizeBytes: 2,
      },
      timings: { startedAt: timestamp, durationMs: 1 },
      redirects: [],
      warnings: [],
    });
    store.requests = [deleted, fallback];
    store.collections = [collection];
    store.selectedCollectionId = collection.id;
    store.current = deleted;
    store.responses = [response(deleted.id), response(fallback.id)];
    store.response = response(deleted.id);

    await store.deleteRequest(deleted.id);

    expect(database.deleteRequestFromWorkspace).toHaveBeenCalledOnce();
    expect(database.deleteRequestFromWorkspace).toHaveBeenCalledWith(
      deleted.id,
      [expect.objectContaining({ requestIds: [fallback.id] })],
    );
    expect(store.requests.map((request) => request.id)).toEqual([fallback.id]);
    expect(store.collections[0]?.requestIds).toEqual([fallback.id]);
    expect(store.responses.map((item) => item.requestId)).toEqual([
      fallback.id,
    ]);
    expect(store.current.id).toBe(fallback.id);
    expect(store.response?.requestId).toBe(fallback.id);
  });

  it("keeps non-cascade collection requests reachable without duplicating shared requests", async () => {
    const store = useWorkbenchStore();
    const exclusive = createDefaultRequest({ id: "request-exclusive" });
    const shared = createDefaultRequest({ id: "request-shared" });
    const timestamp = new Date().toISOString();
    const target: CollectionRecord = {
      id: "collection-target",
      name: "Imported",
      description: "",
      requestIds: [exclusive.id, shared.id],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const other: CollectionRecord = {
      ...target,
      id: "collection-other",
      name: "Other",
      requestIds: [shared.id],
    };
    store.requests = [exclusive, shared];
    store.collections = [target, other];
    store.selectedCollectionId = target.id;

    await store.deleteCollection(target.id, false);

    const fallback = store.collections.find(
      (collection) => collection.name === "My requests",
    );
    expect(store.requests).toHaveLength(2);
    expect(
      store.collections.find((collection) => collection.id === other.id)
        ?.requestIds,
    ).toEqual([shared.id]);
    expect(fallback?.requestIds).toEqual([exclusive.id]);
    expect(store.selectedCollectionId).toBe(fallback?.id);
    expect(store.notice).toContain("moved to My requests");
    expect(database.deleteCollectionFromWorkspace).toHaveBeenCalledWith(
      target.id,
      expect.any(Array),
      [],
    );
  });

  it("cascade-deletes only exclusive requests and keeps shared requests", async () => {
    const store = useWorkbenchStore();
    const exclusive = createDefaultRequest({ id: "request-exclusive" });
    const shared = createDefaultRequest({ id: "request-shared" });
    const timestamp = new Date().toISOString();
    const target: CollectionRecord = {
      id: "collection-target",
      name: "Imported",
      description: "",
      requestIds: [exclusive.id, exclusive.id, shared.id],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const other: CollectionRecord = {
      ...target,
      id: "collection-other",
      name: "Other",
      requestIds: [shared.id],
    };
    const response = (requestId: string) => ({
      requestId,
      executor: "browser" as const,
      status: 200,
      statusText: "OK",
      headers: [],
      body: {
        kind: "inline" as const,
        encoding: "utf8" as const,
        content: "ok",
        sizeBytes: 2,
      },
      timings: { startedAt: timestamp, durationMs: 1 },
      redirects: [],
      warnings: [],
    });
    store.requests = [exclusive, shared];
    store.collections = [target, other];
    store.selectedCollectionId = target.id;
    store.current = exclusive;
    store.responses = [response(exclusive.id), response(shared.id)];
    store.response = response(exclusive.id);

    await store.deleteCollection(target.id, true);

    expect(database.deleteCollectionFromWorkspace).toHaveBeenCalledWith(
      target.id,
      [other],
      [exclusive.id],
    );
    expect(store.requests.map((request) => request.id)).toEqual([shared.id]);
    expect(store.responses.map((item) => item.requestId)).toEqual([shared.id]);
    expect(store.current.id).toBe(shared.id);
    expect(store.response?.requestId).toBe(shared.id);
    expect(store.selectedCollectionId).toBe(other.id);
    expect(store.notice).toContain("1 exclusive request");
  });

  it("replaces the last deleted collection with an empty default collection", async () => {
    const store = useWorkbenchStore();
    const request = createDefaultRequest({ id: "request-only" });
    const timestamp = new Date().toISOString();
    const collection: CollectionRecord = {
      id: "collection-only",
      name: "Only",
      description: "",
      requestIds: [request.id],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    store.requests = [request];
    store.collections = [collection];
    store.selectedCollectionId = collection.id;
    store.current = request;

    await store.deleteCollection(collection.id, true);

    expect(store.requests).toEqual([]);
    expect(store.collections).toHaveLength(1);
    expect(store.collections[0]).toMatchObject({
      id: "collection-default",
      name: "My requests",
      requestIds: [],
    });
    expect(store.selectedCollectionId).toBe("collection-default");
    expect(store.current.id).not.toBe(request.id);
    expect(store.response).toBeNull();
  });

  it("does not mutate in-memory state when the atomic delete fails", async () => {
    const store = useWorkbenchStore();
    const request = createDefaultRequest({ id: "request-still-there" });
    const timestamp = new Date().toISOString();
    const collection: CollectionRecord = {
      id: "collection-one",
      name: "One",
      description: "",
      requestIds: [request.id],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    store.requests = [request];
    store.collections = [collection];
    store.current = request;
    database.deleteRequestFromWorkspace.mockRejectedValueOnce(
      new Error("storage failed"),
    );

    await expect(store.deleteRequest(request.id)).rejects.toThrow(
      "storage failed",
    );

    expect(store.requests.map((item) => item.id)).toEqual([request.id]);
    expect(store.collections[0]?.requestIds).toEqual([request.id]);
    expect(store.current.id).toBe(request.id);
  });
});
