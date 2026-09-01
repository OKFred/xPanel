import { openDB, type DBSchema, type IDBPDatabase } from "idb";

import {
  collectionRecordSchema,
  requestSpecV1Schema,
  type CollectionRecord,
  type RequestSpecV1,
} from "@xpanel/contracts";

interface XPanelDatabase extends DBSchema {
  collections: {
    key: string;
    value: CollectionRecord;
  };
  requests: {
    key: string;
    value: RequestSpecV1;
    indexes: { "by-favorite": number };
  };
}

let databasePromise: Promise<IDBPDatabase<XPanelDatabase>> | undefined;

function database(): Promise<IDBPDatabase<XPanelDatabase>> {
  databasePromise ??= openDB<XPanelDatabase>("xpanel", 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains("collections")) {
        db.createObjectStore("collections", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("requests")) {
        const requests = db.createObjectStore("requests", { keyPath: "id" });
        requests.createIndex("by-favorite", "favorite");
      }
    },
  });
  return databasePromise;
}

export async function loadWorkspace(): Promise<{
  collections: CollectionRecord[];
  requests: RequestSpecV1[];
  warnings: string[];
}> {
  const db = await database();
  const [collections, requests] = await Promise.all([
    db.getAll("collections"),
    db.getAll("requests"),
  ]);
  return validateWorkspaceRecords(collections, requests);
}

export function validateWorkspaceRecords(
  collectionRecords: readonly unknown[],
  requestRecords: readonly unknown[],
): {
  collections: CollectionRecord[];
  requests: RequestSpecV1[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const collections = collectionRecords.flatMap((record, index) => {
    const result = collectionRecordSchema.safeParse(record);
    if (result.success) return [result.data];
    warnings.push(`Ignored invalid collection record ${index + 1}.`);
    return [];
  });
  const requests = requestRecords.flatMap((record, index) => {
    const result = requestSpecV1Schema.safeParse(record);
    if (result.success) return [result.data];
    warnings.push(`Ignored invalid request record ${index + 1}.`);
    return [];
  });
  return { collections, requests, warnings };
}

export async function saveRequest(request: RequestSpecV1): Promise<void> {
  const db = await database();
  await db.put("requests", requestSpecV1Schema.parse(request));
}

export async function saveCollection(
  collection: CollectionRecord,
): Promise<void> {
  const db = await database();
  await db.put("collections", collectionRecordSchema.parse(collection));
}

export async function saveWorkspace(
  collections: CollectionRecord[],
  requests: RequestSpecV1[],
): Promise<void> {
  const db = await database();
  const transaction = db.transaction(["collections", "requests"], "readwrite");
  const validatedCollections = collections.map((collection) =>
    collectionRecordSchema.parse(collection),
  );
  const validatedRequests = requests.map((request) =>
    requestSpecV1Schema.parse(request),
  );
  await Promise.all([
    ...validatedCollections.map((collection) =>
      transaction.objectStore("collections").put(collection),
    ),
    ...validatedRequests.map((request) =>
      transaction.objectStore("requests").put(request),
    ),
    transaction.done,
  ]);
}

export async function removeRequest(id: string): Promise<void> {
  const db = await database();
  await db.delete("requests", id);
}
