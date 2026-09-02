import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia } from "pinia";
import type { Component, Plugin } from "vue";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { RequestSpecV1, ResponseRecordV1 } from "@xpanel/contracts";

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

const execution = vi.hoisted(() => ({
  cancelRequest: vi.fn<(requestId: string) => void>(),
  executeRequest:
    vi.fn<(request: RequestSpecV1) => Promise<ResponseRecordV1>>(),
}));

vi.mock("../src/lib/database", () => database);
vi.mock("../src/lib/execute", () => execution);

const storage = {
  get: vi.fn(async () => ({})),
  remove: vi.fn(async () => undefined),
  set: vi.fn(async () => undefined),
};

let App: Component;
let i18n: Plugin;

function responseFor(requestId: string): ResponseRecordV1 {
  return {
    requestId,
    executor: "browser",
    status: 200,
    statusText: "OK",
    headers: [],
    body: {
      kind: "inline",
      encoding: "utf8",
      content: '{"ok":true}',
      mediaType: "application/json",
      sizeBytes: 11,
    },
    timings: {
      startedAt: new Date().toISOString(),
      durationMs: 1,
    },
    redirects: [],
    warnings: [],
  };
}

async function mountApp(): Promise<VueWrapper> {
  const wrapper = mount(App, {
    global: {
      plugins: [createPinia(), i18n],
    },
  });
  await flushPromises();
  return wrapper;
}

beforeAll(async () => {
  vi.stubGlobal("chrome", {
    devtools: {
      network: {
        getHAR: vi.fn(),
      },
    },
    i18n: {
      getUILanguage: vi.fn(() => "en-US"),
    },
    storage: {
      local: storage,
    },
  });
  const appModule = (await import("../entrypoints/devtools-panel/App.vue")) as {
    default: Component;
  };
  App = appModule.default;
  i18n = (await import("../src/i18n")).i18n;
});

beforeEach(() => {
  vi.clearAllMocks();
  execution.executeRequest.mockReset();
});

describe("DevTools request sending", () => {
  it("passes a plain validated request to the Browser executor", async () => {
    let resolveExecution!: (response: ResponseRecordV1) => void;
    execution.executeRequest.mockReturnValue(
      new Promise<ResponseRecordV1>((resolve) => {
        resolveExecution = resolve;
      }),
    );
    const wrapper = await mountApp();
    await wrapper
      .get('input[aria-label="Request URL"]')
      .setValue("https://example.com/data");

    await wrapper.get("button.send-button").trigger("click");
    await wrapper.vm.$nextTick();

    expect(execution.executeRequest).toHaveBeenCalledOnce();
    const call = execution.executeRequest.mock.calls[0];
    if (!call) throw new Error("Expected the request to be executed.");
    const request = call[0];
    expect(request.url).toBe("https://example.com/data");
    expect(() => structuredClone(request)).not.toThrow();
    expect(wrapper.text()).toContain("Sending request");

    resolveExecution(responseFor(request.id));
    await flushPromises();
    expect(wrapper.text()).toContain("200 OK");
    expect(storage.remove).toHaveBeenCalledWith("executor");
    wrapper.unmount();
  });

  it("shows executor errors and restores the send button", async () => {
    execution.executeRequest.mockRejectedValue(
      new Error("Network unavailable"),
    );
    const wrapper = await mountApp();
    await wrapper
      .get('input[aria-label="Request URL"]')
      .setValue("https://example.com/data");

    await wrapper.get("button.send-button").trigger("click");
    await flushPromises();

    const message = wrapper.get(".message-strip");
    expect(message.text()).toContain("Network unavailable");
    expect(message.attributes("data-error")).toBe("true");
    expect(wrapper.find("button.send-button").exists()).toBe(true);
    wrapper.unmount();
  });
});
