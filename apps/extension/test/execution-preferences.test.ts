import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDefaultRequest } from "@xpanel/contracts";

import {
  EXECUTION_PREFERENCES_KEY,
  StorageCapacityError,
  assertExecutionStorageCapacity,
  ensureExecutionHostPermission,
  loadExecutionPreferences,
  requiredExecutionStorageBytes,
  saveExecutionPreferences,
} from "../src/lib/execution-client";
import {
  DEFAULT_RESPONSE_LIMIT_BYTES,
  MAX_RESPONSE_LIMIT_BYTES,
  MIN_RESPONSE_LIMIT_BYTES,
} from "../src/lib/execution-storage";

const values: Record<string, unknown> = {};

describe("background execution preferences", () => {
  beforeEach(() => {
    for (const key of Object.keys(values)) delete values[key];
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: values[key] })),
          set: vi.fn(async (items: Record<string, unknown>) => {
            Object.assign(values, items);
          }),
        },
      },
    });
  });

  it("uses safe defaults and persists validated choices", async () => {
    await expect(loadExecutionPreferences()).resolves.toEqual({
      schemaVersion: 1,
      retention: "10m",
      responseLimitBytes: DEFAULT_RESPONSE_LIMIT_BYTES,
    });
    await expect(
      saveExecutionPreferences({
        retention: "1h",
        responseLimitBytes: MIN_RESPONSE_LIMIT_BYTES,
      }),
    ).resolves.toMatchObject({ retention: "1h" });
    expect(values[EXECUTION_PREFERENCES_KEY]).toMatchObject({
      responseLimitBytes: MIN_RESPONSE_LIMIT_BYTES,
    });
    await expect(
      saveExecutionPreferences({
        retention: "manual",
        responseLimitBytes: MAX_RESPONSE_LIMIT_BYTES + 1,
      }),
    ).rejects.toThrow();
  });

  it("reserves room for the request snapshot, files, response, and overhead", () => {
    const request = createDefaultRequest({
      body: { kind: "json", text: JSON.stringify({ value: "x".repeat(100) }) },
    });
    const file = new File([new Uint8Array(2_048)], "fixture.bin");
    const required = requiredExecutionStorageBytes(
      request,
      [file],
      DEFAULT_RESPONSE_LIMIT_BYTES,
    );
    expect(required).toBeGreaterThan(
      DEFAULT_RESPONSE_LIMIT_BYTES + file.size + 1024 * 1024,
    );
    expect(() =>
      assertExecutionStorageCapacity({ quota: required, usage: 1 }, required),
    ).toThrow(StorageCapacityError);
    try {
      assertExecutionStorageCapacity({ quota: 10, usage: 9 }, 2);
    } catch (error) {
      expect(error).toMatchObject({ code: "storage_full" });
    }
  });

  it("checks an already granted host permission without opening a prompt", async () => {
    const contains = vi.fn(async () => true);
    const request = vi.fn(async () => true);
    vi.stubGlobal("chrome", {
      storage: chrome.storage,
      permissions: { contains, request },
    });

    await ensureExecutionHostPermission(
      { kind: "browser" },
      createDefaultRequest({ url: "https://api.example.test/items" }),
      true,
    );

    expect(contains).toHaveBeenCalledWith({
      origins: ["https://api.example.test/*"],
    });
    expect(request).not.toHaveBeenCalled();
  });
});
