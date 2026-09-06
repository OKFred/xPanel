// @vitest-environment node
import "fake-indexeddb/auto";

import { createDefaultRequest } from "@xpanel/contracts";
import { deleteDB, openDB } from "idb";
import { beforeAll, describe, expect, it } from "vitest";

import { database, loadWorkspace } from "../src/lib/database";

describe("IndexedDB v2 migration", () => {
  beforeAll(async () => {
    await deleteDB("xpanel");
    const legacy = await openDB("xpanel", 1, {
      upgrade(db) {
        db.createObjectStore("collections", { keyPath: "id" });
        const requests = db.createObjectStore("requests", { keyPath: "id" });
        requests.createIndex("by-favorite", "favorite");
      },
    });
    await legacy.put(
      "requests",
      createDefaultRequest({
        id: "legacy-request",
        url: "https://example.com",
      }),
    );
    legacy.close();
  });

  it("preserves v1 workspace data and adds execution stores", async () => {
    const workspace = await loadWorkspace();
    expect(workspace.requests.map((request) => request.id)).toContain(
      "legacy-request",
    );
    const db = await database();
    expect([...db.objectStoreNames]).toEqual(
      expect.arrayContaining([
        "collections",
        "requests",
        "executions",
        "execution-payloads",
        "execution-files",
        "execution-responses",
        "execution-bodies",
      ]),
    );
  });
});
