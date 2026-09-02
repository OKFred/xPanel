import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, type Pinia } from "pinia";
import type { Component, Plugin } from "vue";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDefaultRequest,
  type CollectionRecord,
  type RequestSpecV1,
  type ResponseRecordV1,
} from "@xpanel/contracts";

import { useWorkbenchStore } from "../src/stores/workbench";

const database = vi.hoisted(() => ({
  loadWorkspace: vi.fn(async () => ({
    collections: [] as CollectionRecord[],
    requests: [] as RequestSpecV1[],
    warnings: [],
  })),
  saveCollection: vi.fn(async () => undefined),
  saveRequest: vi.fn(async () => undefined),
  saveWorkspace: vi.fn(async () => undefined),
  deleteCollectionFromWorkspace: vi.fn(async () => undefined),
  deleteRequestFromWorkspace: vi.fn(async () => undefined),
}));

const execution = vi.hoisted(() => ({
  cancelRequest: vi.fn<(requestId: string) => void>(),
  executeRequest:
    vi.fn<(request: RequestSpecV1) => Promise<ResponseRecordV1>>(),
  sanitizeBrowserRequestHeaders: vi.fn<
    (request: RequestSpecV1) => {
      request: RequestSpecV1;
      removedHeaders: { name: string; occurrences: number }[];
    }
  >(),
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

async function mountApp(pinia: Pinia = createPinia()): Promise<VueWrapper> {
  const wrapper = mount(App, {
    global: {
      plugins: [pinia, i18n],
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
  execution.sanitizeBrowserRequestHeaders.mockReset();
  execution.sanitizeBrowserRequestHeaders.mockImplementation((request) => {
    const sanitized = structuredClone(request);
    const removed = sanitized.headers.filter((header) =>
      ["dnt", "origin"].includes(header.name.toLowerCase()),
    );
    sanitized.headers = sanitized.headers.filter(
      (header) => !["dnt", "origin"].includes(header.name.toLowerCase()),
    );
    return {
      request: sanitized,
      removedHeaders: [...new Set(removed.map((header) => header.name))].map(
        (name) => ({
          name,
          occurrences: removed.filter((header) => header.name === name).length,
        }),
      ),
    };
  });
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

  it("keeps automatic filtering off and surfaces forbidden-header errors", async () => {
    const pinia = createPinia();
    const wrapper = await mountApp(pinia);
    const store = useWorkbenchStore(pinia);
    store.current.url = "https://example.com/imported";
    store.current.headers.push({
      name: "DNT",
      value: "1",
      enabled: true,
      sensitive: false,
    });
    execution.executeRequest.mockRejectedValue(
      new Error("Browser Fetch cannot preserve the forbidden DNT header."),
    );

    await wrapper.get("button.send-button").trigger("click");
    await flushPromises();

    expect(execution.sanitizeBrowserRequestHeaders).not.toHaveBeenCalled();
    expect(execution.executeRequest.mock.calls[0]?.[0].headers).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "DNT" })]),
    );
    expect(wrapper.text()).toContain(
      "Browser Fetch cannot preserve the forbidden DNT header.",
    );
    wrapper.unmount();
  });

  it("filters only the execution copy and reports the removed headers", async () => {
    storage.get.mockResolvedValueOnce({ autoFilterBrowserHeaders: true });
    const pinia = createPinia();
    const wrapper = await mountApp(pinia);
    const store = useWorkbenchStore(pinia);
    store.current.url = "https://example.com/imported";
    store.current.headers.push(
      {
        name: "DNT",
        value: "1",
        enabled: true,
        sensitive: false,
      },
      {
        name: "Origin",
        value: "https://source.example",
        enabled: true,
        sensitive: false,
      },
      {
        name: "X-Trace",
        value: "kept",
        enabled: true,
        sensitive: false,
      },
    );
    execution.executeRequest.mockImplementation(async (request) =>
      responseFor(request.id),
    );

    await wrapper.get("button.send-button").trigger("click");
    await flushPromises();

    expect(execution.sanitizeBrowserRequestHeaders).toHaveBeenCalledOnce();
    const executed = execution.executeRequest.mock.calls[0]?.[0];
    expect(executed?.headers.map((header) => header.name)).toEqual(["X-Trace"]);
    expect(store.current.headers.map((header) => header.name)).toEqual([
      "DNT",
      "Origin",
      "X-Trace",
    ]);
    expect(wrapper.text()).toContain(
      "Filtered 2 browser-controlled header(s) for this send: DNT, Origin.",
    );
    const filterWarning = store.response?.warnings.find(
      (warning) => warning.code === "browser.headers_filtered",
    );
    expect(filterWarning?.path).toBe("headers");
    expect(filterWarning?.message).toContain("DNT, Origin");
    wrapper.unmount();
  });

  it("keeps the filtering notice when another unsupported option fails", async () => {
    storage.get.mockResolvedValueOnce({ autoFilterBrowserHeaders: true });
    const pinia = createPinia();
    const wrapper = await mountApp(pinia);
    const store = useWorkbenchStore(pinia);
    store.current.url = "https://example.com/imported";
    store.current.headers.push({
      name: "DNT",
      value: "1",
      enabled: true,
      sensitive: false,
    });
    store.current.options.proxy = {
      url: "http://proxy.example:8080",
      bypass: [],
    };
    execution.executeRequest.mockRejectedValue(
      new Error(
        "Browser Fetch cannot preserve this request because it uses an explicit proxy.",
      ),
    );

    await wrapper.get("button.send-button").trigger("click");
    await flushPromises();

    const message = wrapper.get(".message-strip");
    expect(message.text()).toContain("an explicit proxy");
    expect(message.text()).toContain(
      "Filtered 1 browser-controlled header(s) for this send: DNT.",
    );
    expect(message.attributes("data-error")).toBe("true");
    expect(store.current.headers).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "DNT" })]),
    );
    wrapper.unmount();
  });

  it("loads and saves the automatic filtering preference", async () => {
    storage.get.mockResolvedValueOnce({ autoFilterBrowserHeaders: true });
    const wrapper = await mountApp();
    const optionsTab = wrapper
      .findAll(".tab-list button")
      .find((button) => button.text() === "Options");
    if (!optionsTab) throw new Error("Expected the Options tab.");
    await optionsTab.trigger("click");
    const checkbox = wrapper
      .findAll('input[type="checkbox"]')
      .find((input) =>
        input.element.parentElement?.textContent?.includes(
          "Automatically filter browser-controlled headers",
        ),
      );
    if (!checkbox) throw new Error("Expected the automatic filtering option.");
    expect((checkbox.element as HTMLInputElement).checked).toBe(true);

    await checkbox.setValue(false);
    await flushPromises();

    expect(storage.set).toHaveBeenCalledWith({
      autoFilterBrowserHeaders: false,
    });
    wrapper.unmount();
  });

  it("shows a 60-second default and stores timeout edits as milliseconds", async () => {
    const wrapper = await mountApp();
    const optionsTab = wrapper
      .findAll(".tab-list button")
      .find((button) => button.text() === "Options");
    if (!optionsTab) throw new Error("Expected the Options tab.");
    await optionsTab.trigger("click");
    const timeout = wrapper.get('input[aria-label="Timeout (seconds)"]');
    expect((timeout.element as HTMLInputElement).value).toBe("60");
    expect(timeout.attributes("min")).toBe("0.001");
    expect(timeout.attributes("max")).toBe("86400");
    expect(timeout.attributes("step")).toBe("0.001");
    await timeout.setValue("12");
    await timeout.trigger("blur");

    await wrapper
      .get('input[aria-label="Request URL"]')
      .setValue("https://example.com/timeout");
    execution.executeRequest.mockImplementation(async (request) =>
      responseFor(request.id),
    );
    await wrapper.get("button.send-button").trigger("click");
    await flushPromises();

    const call = execution.executeRequest.mock.calls[0];
    if (!call) throw new Error("Expected the request to be executed.");
    expect(call[0].options.timeoutMs).toBe(12_000);
    wrapper.unmount();
  });

  it.each([
    ["0", "zero"],
    ["", "empty"],
    ["86400.001", "above the maximum"],
  ])(
    "restores the stored timeout when the seconds value is %s (%s)",
    async (value) => {
      const wrapper = await mountApp();
      const optionsTab = wrapper
        .findAll(".tab-list button")
        .find((button) => button.text() === "Options");
      if (!optionsTab) throw new Error("Expected the Options tab.");
      await optionsTab.trigger("click");
      const timeout = wrapper.get('input[aria-label="Timeout (seconds)"]');

      await timeout.setValue(value);
      await timeout.trigger("blur");

      expect((timeout.element as HTMLInputElement).value).toBe("60");
      expect(wrapper.text()).toContain(
        "Timeout must be between 0.001 and 86400 seconds.",
      );

      await wrapper
        .get('input[aria-label="Request URL"]')
        .setValue("https://example.com/timeout-boundary");
      execution.executeRequest.mockImplementation(async (request) =>
        responseFor(request.id),
      );
      await wrapper.get("button.send-button").trigger("click");
      await flushPromises();

      const call = execution.executeRequest.mock.calls[0];
      if (!call) throw new Error("Expected the request to be executed.");
      expect(call[0].options.timeoutMs).toBe(60_000);
      wrapper.unmount();
    },
  );

  it.each([
    ["0.001", 1],
    ["86400", 86_400_000],
  ])(
    "accepts the timeout boundary %s seconds as %i milliseconds",
    async (value, expectedMilliseconds) => {
      const wrapper = await mountApp();
      const optionsTab = wrapper
        .findAll(".tab-list button")
        .find((button) => button.text() === "Options");
      if (!optionsTab) throw new Error("Expected the Options tab.");
      await optionsTab.trigger("click");
      const timeout = wrapper.get('input[aria-label="Timeout (seconds)"]');

      await timeout.setValue(value);
      await timeout.trigger("blur");
      expect((timeout.element as HTMLInputElement).value).toBe(value);

      await wrapper
        .get('input[aria-label="Request URL"]')
        .setValue("https://example.com/timeout-boundary");
      execution.executeRequest.mockImplementation(async (request) =>
        responseFor(request.id),
      );
      await wrapper.get("button.send-button").trigger("click");
      await flushPromises();

      const call = execution.executeRequest.mock.calls[0];
      if (!call) throw new Error("Expected the request to be executed.");
      expect(call[0].options.timeoutMs).toBe(expectedMilliseconds);
      wrapper.unmount();
    },
  );
});

describe("request importing", () => {
  it("closes a successful warning dialog and keeps the imported request selectable", async () => {
    const pinia = createPinia();
    const wrapper = await mountApp(pinia);
    const store = useWorkbenchStore(pinia);
    const openImport = wrapper
      .findAll("button")
      .find((button) => button.text().trim() === "Import");
    if (!openImport) throw new Error("Expected the Import button.");
    await openImport.trigger("click");
    const dialog = wrapper.get('[aria-label="Import requests"]');
    await dialog
      .get("textarea.dialog-editor")
      .setValue("curl 'https://api.example.com' --max-time 0");

    await dialog.get("button.primary-button").trigger("click");
    await flushPromises();

    expect(wrapper.find('[aria-label="Import requests"]').exists()).toBe(false);
    expect(wrapper.text()).toContain(
      "Imported with 1 warning(s). Reopen Import to review them.",
    );
    const loadRequest = vi.spyOn(store, "loadRequest");
    const imported = wrapper
      .findAll("button.request-link")
      .find((button) => button.text().includes("Imported cURL 1"));
    if (!imported)
      throw new Error("Expected the imported request in the sidebar.");

    await imported.trigger("click");

    expect(loadRequest).toHaveBeenCalledOnce();
    expect(store.current.name).toBe("Imported cURL 1");
    wrapper.unmount();
  });
});

describe("saved item deletion", () => {
  const importedRequest = createDefaultRequest({
    id: "request-imported",
    name: "Imported cURL 1",
    method: "POST",
    favorite: true,
  });
  const importedCollection: CollectionRecord = {
    id: "collection-imported",
    name: "Imported 9/2/2026, 10:51:11 AM",
    description: "Imported collection",
    requestIds: [importedRequest.id],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it("opens an accessible request confirmation without loading the row", async () => {
    database.loadWorkspace.mockResolvedValueOnce({
      collections: [importedCollection],
      requests: [importedRequest],
      warnings: [],
    });
    const pinia = createPinia();
    const wrapper = await mountApp(pinia);
    const store = useWorkbenchStore(pinia);
    const loadRequest = vi.spyOn(store, "loadRequest");
    const deleteRequest = vi
      .spyOn(store, "deleteRequest")
      .mockResolvedValue(undefined);
    const focus = vi.spyOn(HTMLButtonElement.prototype, "focus");

    const deleteButtons = wrapper.findAll(
      'button[aria-label="Delete request: Imported cURL 1"]',
    );
    expect(deleteButtons).toHaveLength(2);
    await deleteButtons[0]?.trigger("click");

    expect(loadRequest).not.toHaveBeenCalled();
    const dialog = wrapper.get('[role="alertdialog"]');
    expect(dialog.attributes("aria-modal")).toBe("true");
    expect(dialog.text()).toContain("Delete request?");
    expect(dialog.text()).toContain("every collection and Favorites");
    expect(dialog.text()).toContain("This action cannot be undone.");
    expect(wrapper.get("aside.sidebar").attributes()).toHaveProperty("inert");
    const cancel = dialog.get("button.ghost-button");
    expect(focus.mock.instances).toContain(cancel.element);

    await cancel.trigger("click");

    expect(deleteRequest).not.toHaveBeenCalled();
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false);

    await deleteButtons[0]?.trigger("click");
    const reopenedDialog = wrapper.get('[role="alertdialog"]');
    const confirm = reopenedDialog.get("button.danger-button");
    store.busy = true;
    await wrapper.vm.$nextTick();
    expect(confirm.attributes()).toHaveProperty("disabled");
    await confirm.trigger("click");
    expect(deleteRequest).not.toHaveBeenCalled();

    store.busy = false;
    await wrapper.vm.$nextTick();
    await confirm.trigger("click");
    await flushPromises();

    expect(deleteRequest).toHaveBeenCalledWith(importedRequest.id);
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("keeps collection requests by default and passes a non-cascade delete", async () => {
    database.loadWorkspace.mockResolvedValueOnce({
      collections: [importedCollection],
      requests: [importedRequest],
      warnings: [],
    });
    const pinia = createPinia();
    const wrapper = await mountApp(pinia);
    const store = useWorkbenchStore(pinia);
    const deleteCollection = vi
      .spyOn(store, "deleteCollection")
      .mockResolvedValue(undefined);

    await wrapper
      .get(
        'button[aria-label="Delete collection: Imported 9/2/2026, 10:51:11 AM"]',
      )
      .trigger("click");

    const dialog = wrapper.get('[role="alertdialog"]');
    const cascade = dialog.get('input[type="checkbox"]');
    expect((cascade.element as HTMLInputElement).checked).toBe(false);
    expect(dialog.text()).toContain("move to My requests");

    await dialog.get("button.danger-button").trigger("click");
    await flushPromises();

    expect(deleteCollection).toHaveBeenCalledWith(importedCollection.id, false);
    wrapper.unmount();
  });

  it("shows exclusive/shared impact before a collection cascade delete", async () => {
    const sharedRequest = createDefaultRequest({
      id: "request-shared",
      name: "Shared request",
    });
    const targetCollection = {
      ...importedCollection,
      requestIds: [importedRequest.id, sharedRequest.id],
    };
    const otherCollection: CollectionRecord = {
      id: "collection-other",
      name: "Other collection",
      description: "",
      requestIds: [sharedRequest.id],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    database.loadWorkspace.mockResolvedValueOnce({
      collections: [targetCollection, otherCollection],
      requests: [importedRequest, sharedRequest],
      warnings: [],
    });
    const pinia = createPinia();
    const wrapper = await mountApp(pinia);
    const store = useWorkbenchStore(pinia);
    const deleteCollection = vi
      .spyOn(store, "deleteCollection")
      .mockResolvedValue(undefined);

    await wrapper
      .get(
        'button[aria-label="Delete collection: Imported 9/2/2026, 10:51:11 AM"]',
      )
      .trigger("click");
    const dialog = wrapper.get('[role="alertdialog"]');
    const cascade = dialog.get('input[type="checkbox"]');
    expect(dialog.get(".cascade-delete").text()).toContain("(1)");

    await cascade.setValue(true);
    expect(dialog.text()).toContain(
      "Exclusive requests permanently deleted and removed from Favorites: 1.",
    );
    expect(dialog.text()).toContain(
      "Shared requests kept in their other collections: 1.",
    );
    await dialog.get("button.danger-button").trigger("click");
    await flushPromises();

    expect(deleteCollection).toHaveBeenCalledWith(targetCollection.id, true);
    wrapper.unmount();
  });
});
