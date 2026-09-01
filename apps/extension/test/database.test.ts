import { describe, expect, it } from "vitest";

import { createDefaultRequest, type CollectionRecord } from "@xpanel/contracts";

import { validateWorkspaceRecords } from "../src/lib/database";

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
});
