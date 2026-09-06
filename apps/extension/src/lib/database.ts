import { openDB, type DBSchema, type IDBPDatabase } from "idb";

import {
  collectionRecordSchema,
  requestSpecV1Schema,
  type CollectionRecord,
  type RequestSpecV1,
} from "@xpanel/contracts";

import type {
  ExecutionFileRecord,
  ExecutionPayloadRecord,
  StoredExecutionRecord,
  StoredResponseBody,
  StoredResponseMetadata,
} from "./execution-storage";

export interface XPanelDatabase extends DBSchema {
  collections: {
    key: string;
    value: CollectionRecord;
  };
  requests: {
    key: string;
    value: RequestSpecV1;
    indexes: { "by-favorite": number };
  };
  executions: {
    key: string;
    value: StoredExecutionRecord;
    indexes: {
      "by-state": string;
      "by-updated-at": string;
    };
  };
  "execution-payloads": {
    key: string;
    value: ExecutionPayloadRecord;
    indexes: { "by-execution": string };
  };
  "execution-files": {
    key: string;
    value: ExecutionFileRecord;
    indexes: { "by-payload": string };
  };
  "execution-responses": {
    key: string;
    value: StoredResponseMetadata;
    indexes: { "by-execution": string };
  };
  "execution-bodies": {
    key: string;
    value: StoredResponseBody;
    indexes: { "by-execution": string };
  };
}

let databasePromise: Promise<IDBPDatabase<XPanelDatabase>> | undefined;

export function database(): Promise<IDBPDatabase<XPanelDatabase>> {
  databasePromise ??= openDB<XPanelDatabase>("xpanel", 2, {
    upgrade(db) {
      if (!db.objectStoreNames.contains("collections")) {
        db.createObjectStore("collections", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("requests")) {
        const requests = db.createObjectStore("requests", { keyPath: "id" });
        requests.createIndex("by-favorite", "favorite");
      }
      if (!db.objectStoreNames.contains("executions")) {
        const executions = db.createObjectStore("executions", {
          keyPath: "summary.executionId",
        });
        executions.createIndex("by-state", "summary.state");
        executions.createIndex("by-updated-at", "summary.updatedAt");
      }
      if (!db.objectStoreNames.contains("execution-payloads")) {
        const payloads = db.createObjectStore("execution-payloads", {
          keyPath: "handle",
        });
        payloads.createIndex("by-execution", "executionId", {
          unique: true,
        });
      }
      if (!db.objectStoreNames.contains("execution-files")) {
        const files = db.createObjectStore("execution-files", {
          keyPath: "key",
        });
        files.createIndex("by-payload", "payloadHandle");
      }
      if (!db.objectStoreNames.contains("execution-responses")) {
        const responses = db.createObjectStore("execution-responses", {
          keyPath: "handle",
        });
        responses.createIndex("by-execution", "executionId", {
          unique: true,
        });
      }
      if (!db.objectStoreNames.contains("execution-bodies")) {
        const bodies = db.createObjectStore("execution-bodies", {
          keyPath: "handle",
        });
        bodies.createIndex("by-execution", "executionId", {
          unique: true,
        });
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

export async function deleteRequestFromWorkspace(
  id: string,
  collections: CollectionRecord[],
): Promise<void> {
  const db = await database();
  const validatedId = requestSpecV1Schema.shape.id.parse(id);
  const validatedCollections = collections.map((collection) =>
    collectionRecordSchema.parse(collection),
  );
  const transaction = db.transaction(["collections", "requests"], "readwrite");

  await Promise.all([
    transaction.objectStore("requests").delete(validatedId),
    ...validatedCollections.map((collection) =>
      transaction.objectStore("collections").put(collection),
    ),
    transaction.done,
  ]);
}

export async function deleteCollectionFromWorkspace(
  id: string,
  collections: CollectionRecord[],
  requestIds: string[] = [],
): Promise<void> {
  const db = await database();
  const validatedId = collectionRecordSchema.shape.id.parse(id);
  const validatedCollections = collections.map((collection) =>
    collectionRecordSchema.parse(collection),
  );
  const validatedRequestIds = [
    ...new Set(
      requestIds.map((requestId) =>
        requestSpecV1Schema.shape.id.parse(requestId),
      ),
    ),
  ];
  const transaction = db.transaction(["collections", "requests"], "readwrite");

  await Promise.all([
    transaction.objectStore("collections").delete(validatedId),
    ...validatedCollections.map((collection) =>
      transaction.objectStore("collections").put(collection),
    ),
    ...validatedRequestIds.map((requestId) =>
      transaction.objectStore("requests").delete(requestId),
    ),
    transaction.done,
  ]);
}
