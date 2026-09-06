import { flushPromises } from "@vue/test-utils";
import { createPinia } from "pinia";
import { describe, expect, it, vi } from "vitest";

import type { ResponseRecordV1 } from "@xpanel/contracts";

import { useWorkbenchStore } from "../src/stores/workbench";
import {
  execution,
  mountApp,
  remoteProfiles,
  responseFor,
  storage,
} from "./devtools-app.harness";

vi.mock(
  "../src/lib/database",
  async () => (await import("./devtools-app.harness")).database,
);
vi.mock(
  "../src/lib/execute",
  async () => (await import("./devtools-app.harness")).execution,
);
vi.mock(
  "../src/lib/execution-client",
  async () => (await import("./devtools-app.harness")).backgroundExecution,
);
vi.mock(
  "../src/lib/remote-profiles",
  async () => (await import("./devtools-app.harness")).remoteProfiles,
);

describe("DevTools interface localization", () => {
  it("switches editor text and accessibility labels to Chinese", async () => {
    const pinia = createPinia();
    const wrapper = await mountApp(pinia);
    const store = useWorkbenchStore(pinia);
    wrapper.get('input[aria-label="Request URL"]');
    expect(wrapper.get("button.add-row").text()).toContain("Add");

    await wrapper.get('button[aria-label="Switch language"]').trigger("click");
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain("MV3 · 本地优先");
    expect(wrapper.text()).toContain("我的请求");
    wrapper.get('input[aria-label="请求 URL"]');
    wrapper.get('nav[aria-label="请求编辑页签"]');
    expect(wrapper.get("button.add-row").text()).toContain("添加");
    expect(wrapper.get(".response-tabs").text()).toContain("响应头");
    await wrapper.get("button.add-row").trigger("click");
    wrapper.get('input[aria-label^="启用"]');

    const bodyTab = wrapper
      .findAll(".request-pane .tab-list button")
      .find((button) => button.text().trim() === "正文");
    if (!bodyTab) throw new Error("Expected the localized Body tab.");
    await bodyTab.trigger("click");
    expect(wrapper.text()).toContain("此请求没有正文。");
    expect(wrapper.get(".body-editor select").text()).toContain("无正文");
    store.notice = "Saved locally with sensitive values redacted.";
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("已在本机保存，敏感值已脱敏。");
    wrapper.unmount();
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
    expect(remoteProfiles.getSessionExecutorSelection).toHaveBeenCalledOnce();
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
    expect(wrapper.text()).toContain("DNT, Origin");
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
