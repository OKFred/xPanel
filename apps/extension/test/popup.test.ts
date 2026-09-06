import { flushPromises, mount } from "@vue/test-utils";
import type { Component, Plugin } from "vue";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ExecutionEventV1,
  ExecutionSummaryV1,
} from "@xpanel/contracts";

const executionClient = vi.hoisted(() => ({
  listExecutionSummaries: vi.fn<() => Promise<ExecutionSummaryV1[]>>(),
  listener: undefined as ((event: ExecutionEventV1) => void) | undefined,
  unsubscribe: vi.fn(),
  subscribeExecutionEvents: vi.fn((listener: (event: ExecutionEventV1) => void) => {
    executionClient.listener = listener;
    return executionClient.unsubscribe;
  }),
}));

vi.mock("../src/lib/execution-client", () => executionClient);

const tabsUpdate = vi.fn(async () => undefined);
const tabsCreate = vi.fn(async () => undefined);
const windowsUpdate = vi.fn(async () => undefined);
const getContexts = vi.fn(async () => [
  {
    contextType: "TAB",
    contextId: "context-1",
    documentOrigin: "chrome-extension://extension-id",
    documentUrl: "chrome-extension://extension-id/workbench.html#/request",
    tabId: 12,
    windowId: 5,
    incognito: false,
  },
]);

let App: Component;
let i18n: Plugin;

function execution(state: ExecutionSummaryV1["state"]): ExecutionSummaryV1 {
  return {
    schemaVersion: 1,
    executionId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    executor: "browser",
    state,
    retention: "10m",
    revision: 1,
    progress: { phase: "waiting", loadedBytes: 0, elapsedMs: 10 },
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:01.000Z",
    expiresAt: "2026-09-06T00:10:00.000Z",
  };
}

beforeAll(async () => {
  vi.stubGlobal("chrome", {
    i18n: { getUILanguage: vi.fn(() => "en-US") },
    runtime: {
      getManifest: vi.fn(() => ({ version: "2.1.0" })),
      getURL: vi.fn((path: string) => `chrome-extension://extension-id/${path}`),
      getContexts,
    },
    tabs: { create: tabsCreate, update: tabsUpdate },
    windows: { update: windowsUpdate },
  });
  App = (await import("../entrypoints/popup/App.vue")).default;
  i18n = (await import("../src/i18n")).i18n;
});

beforeEach(() => {
  vi.clearAllMocks();
  executionClient.listener = undefined;
  executionClient.listExecutionSummaries.mockResolvedValue([execution("running")]);
  vi.spyOn(window, "close").mockImplementation(() => undefined);
});

describe("extension popup", () => {
  it("shows the manifest version and focuses an existing workbench tab", async () => {
    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();
    expect(wrapper.text()).toContain("Version 2.1.0");
    expect(wrapper.text()).toContain("1 request(s) running");

    await wrapper.get("button.popup-open").trigger("click");
    await flushPromises();
    expect(tabsUpdate).toHaveBeenCalledWith(12, { active: true });
    expect(windowsUpdate).toHaveBeenCalledWith(5, { focused: true });
    expect(tabsCreate).not.toHaveBeenCalled();
  });

  it("updates the latest status from execution events", async () => {
    executionClient.listExecutionSummaries.mockResolvedValue([]);
    const wrapper = mount(App, { global: { plugins: [i18n] } });
    await flushPromises();
    const completed = { ...execution("succeeded"), state: "succeeded" as const };
    executionClient.listener?.({
      protocolVersion: 1,
      eventId: crypto.randomUUID(),
      type: "execution.completed",
      execution: { ...completed, responseHandle: "response-1" },
    });
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("Latest: completed");
    wrapper.unmount();
    expect(executionClient.unsubscribe).toHaveBeenCalledOnce();
  });
});
