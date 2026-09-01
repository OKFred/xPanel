import {
  collectionFileV1Schema,
  redactCollectionFileForExport,
  type CollectionFileV1,
  type CollectionRecord,
  type ImportWarning,
  type RequestSpecV1,
} from "@xpanel/contracts";

import { safeId, warning } from "./common.js";
import type { MergeCollectionsResult } from "./types.js";

export interface CollectionParseResult {
  file?: CollectionFileV1;
  warnings: ImportWarning[];
}

export function parseCollectionFile(
  input: string | object,
): CollectionParseResult {
  let value: unknown;
  try {
    value = typeof input === "string" ? JSON.parse(input) : input;
  } catch (error) {
    return {
      warnings: [
        warning(
          "collection.parse_failed",
          `Collection JSON could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ],
    };
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    value.schemaVersion !== 1
  ) {
    return {
      warnings: [
        warning(
          "collection.version_unsupported",
          `Collection schema version ${String(value.schemaVersion)} is not supported. The original input was left unchanged.`,
        ),
      ],
    };
  }
  const parsed = collectionFileV1Schema.safeParse(value);
  if (!parsed.success) {
    return {
      warnings: parsed.error.issues.map((issue) =>
        warning(
          "collection.validation_failed",
          issue.message,
          issue.path.join("."),
        ),
      ),
    };
  }
  return { file: parsed.data, warnings: [] };
}

export function exportCollectionFile(
  collections: CollectionRecord[],
  requests: RequestSpecV1[],
  options: { includeSensitive?: boolean; exportedAt?: string } = {},
): CollectionFileV1 {
  return exportCollectionFileWithWarnings(collections, requests, options).value;
}

export function exportCollectionFileWithWarnings(
  collections: CollectionRecord[],
  requests: RequestSpecV1[],
  options: { includeSensitive?: boolean; exportedAt?: string } = {},
): { value: CollectionFileV1; warnings: ImportWarning[] } {
  const file = collectionFileV1Schema.parse({
    schemaVersion: 1,
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    collections,
    requests,
  });
  if (options.includeSensitive) return { value: file, warnings: [] };
  return redactCollectionFileForExport(file);
}

export function mergeCollectionFiles(
  existing: CollectionFileV1,
  incoming: CollectionFileV1,
): CollectionFileV1 {
  const merged = mergeCollections(
    existing.collections,
    existing.requests,
    incoming.collections,
    incoming.requests,
  );
  return collectionFileV1Schema.parse({
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    collections: merged.collections,
    requests: merged.requests,
  });
}

export function mergeCollections(
  existingCollections: CollectionRecord[],
  existingRequests: RequestSpecV1[],
  incomingCollections: CollectionRecord[],
  incomingRequests: RequestSpecV1[],
): MergeCollectionsResult {
  const collections = structuredClone(existingCollections);
  const requests = structuredClone(existingRequests);
  const existingRequestIds = new Set(requests.map((request) => request.id));
  const existingCollectionIds = new Set(
    collections.map((collection) => collection.id),
  );
  const existingNames = new Set(
    collections.map((collection) => collection.name),
  );
  const idMap: Record<string, string> = {};

  for (const incoming of incomingRequests) {
    let id = incoming.id;
    while (existingRequestIds.has(id)) id = safeId("request");
    existingRequestIds.add(id);
    idMap[incoming.id] = id;
    requests.push({ ...structuredClone(incoming), id });
  }

  for (const incoming of incomingCollections) {
    let id = incoming.id;
    while (existingCollectionIds.has(id)) id = safeId("collection");
    existingCollectionIds.add(id);
    const name = uniqueImportedName(incoming.name, existingNames);
    existingNames.add(name);
    collections.push({
      ...structuredClone(incoming),
      id,
      name,
      requestIds: incoming.requestIds
        .map((requestId) => idMap[requestId])
        .filter((requestId): requestId is string => requestId !== undefined),
      updatedAt: new Date().toISOString(),
    });
  }
  return { collections, requests, idMap };
}

function uniqueImportedName(name: string, existing: Set<string>): string {
  if (!existing.has(name)) return name;
  let suffix = 1;
  let candidate = `${name} (imported)`;
  while (existing.has(candidate)) {
    suffix += 1;
    candidate = `${name} (imported ${suffix})`;
  }
  return candidate;
}
