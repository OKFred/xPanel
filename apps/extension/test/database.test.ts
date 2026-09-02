import { describe, expect, it, vi } from "vitest";

import { createDefaultRequest, type CollectionRecord } from "@xpanel/contracts";

const idb = vi.hoisted(() => ({ openDB: vi.fn() }));

vi.mock("idb", () => idb);

import {
  deleteCollectionFromWorkspace,
  deleteRequestFromWorkspace,
  validateWorkspaceRecords,
} from "../src/lib/database";

describe("IndexedDB runtime validation", () => {
  it("keeps valid records and isolates corrupt or unsupported records", () => {
    const timestamp = new Date().toISOString();
    const request = createDefaultRequest({ url: "https://example.com" });
    const collection: CollectionRecord = {
      id: "collection-valid",
      name: "Valid",
      description: "",
      requestIds: [request.id],
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const result = validateWorkspaceRecords(
      [collection, { ...collection, id: 7 }],
      [request, { ...request, source: { kind: "xpanel", version: 99 } }],
    );

    expect(result.collections).toEqual([collection]);
    expect(result.requests).toEqual([request]);
    expect(result.warnings).toHaveLength(2);
  });

  it("deletes records and updates collection references in one transaction", async () => {
    const request = createDefaultRequest({ id: "request-delete" });
    const timestamp = new Date().toISOString();
    const updatedCollection: CollectionRecord = {
      id: "collection-one",
      name: "One",
      description: "",
      requestIds: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const fallbackCollection: CollectionRecord = {
      ...updatedCollection,
      id: "collection-default",
      name: "My requests",
    };
    const requestStore = {
      delete: vi.fn(async () => undefined),
      put: vi.fn(async () => undefined),
    };
    const collectionStore = {
      delete: vi.fn(async () => undefined),
      put: vi.fn(async () => undefined),
    };
    const transactions: unknown[] = [];
    const db = {
      transaction: vi.fn(() => {
        const transaction = {
          objectStore: vi.fn((name: string) =>
            name === "requests" ? requestStore : collectionStore,
          ),
          done: Promise.resolve(),
        };
        transactions.push(transaction);
        return transaction;
      }),
    };
    idb.openDB.mockResolvedValue(db);

    await deleteRequestFromWorkspace(request.id, [updatedCollection]);

    expect(db.transaction).toHaveBeenNthCalledWith(
      1,
      ["collections", "requests"],
      "readwrite",
    );
    expect(requestStore.delete).toHaveBeenCalledWith(request.id);
    expect(collectionStore.put).toHaveBeenCalledWith(updatedCollection);
    expect(transactions).toHaveLength(1);

    await deleteCollectionFromWorkspace(
      updatedCollection.id,
      [fallbackCollection],
      [request.id, request.id],
    );

    expect(db.transaction).toHaveBeenNthCalledWith(
      2,
      ["collections", "requests"],
      "readwrite",
    );
    expect(collectionStore.delete).toHaveBeenCalledWith(updatedCollection.id);
    expect(collectionStore.put).toHaveBeenCalledWith(fallbackCollection);
    expect(requestStore.delete).toHaveBeenCalledTimes(2);
    expect(transactions).toHaveLength(2);
  });
});
