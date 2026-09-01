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
});
