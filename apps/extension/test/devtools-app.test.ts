import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, type Pinia } from "pinia";
import type { Component, Plugin } from "vue";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDefaultRequest,
  type CollectionRecord,
  type ExecutionProgressV1,
  type RemoteCapabilitiesV1,
  type RemoteRelayProfileV1,
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
  browserUnsupportedReasons: vi.fn<(request: RequestSpecV1) => string[]>(),
  cancelRequest: vi.fn<(requestId: string) => void>(),
  executeRequest: vi.fn<
    (
      request: RequestSpecV1,
      options?: {
        target?:
          | { kind: "browser" }
          | {
              kind: "remote";
              profile: RemoteRelayProfileV1;
              token: string;
            };
        relayPermissionAlreadyGranted?: boolean;
        onProgress?: (progress: ExecutionProgressV1) => void;
      },
    ) => Promise<ResponseRecordV1>
  >(),
  sanitizeBrowserRequestHeaders: vi.fn<
    (request: RequestSpecV1) => {
      request: RequestSpecV1;
      removedHeaders: { name: string; occurrences: number }[];
    }
  >(),
}));

const remoteProfiles = vi.hoisted(() => ({
  deleteRelayProfile: vi.fn(async () => undefined),
  ensureRelayPermission: vi.fn(async () => undefined),
  getRelayToken: vi.fn(async () => null as string | null),
  getSessionExecutorSelection: vi.fn(async () => "browser"),
  isRelayTrusted: vi.fn(async () => false),
  loadRelayProfiles: vi.fn(async () => [] as RemoteRelayProfileV1[]),
  revokeRelayTrust: vi.fn(async () => undefined),
  saveRelayProfile: vi.fn(async (profile: RemoteRelayProfileV1) => profile),
  setSessionExecutorSelection: vi.fn(async () => undefined),
  testRelayConnection: vi.fn(
    async () =>
      ({
        protocolVersion: 1,
        provider: "cloudflare",
        targetPolicy: "allowlist",
        maxMetadataBytes: 49_152,
        maxRequestBodyBytes: 20_971_520,
        maxResponseBodyBytes: 20_971_520,
        features: {
          explicitCookie: true,
          responseSetCookie: true,
          files: true,
          multipart: true,
          proxy: false,
          customTls: false,
          clientCertificate: false,
        },
      }) satisfies RemoteCapabilitiesV1,
  ),
  trustRelayForSession: vi.fn<
    (_profile: RemoteRelayProfileV1, _token: string) => Promise<void>
  >(async () => undefined),
}));

vi.mock("../src/lib/database", () => database);
vi.mock("../src/lib/execute", () => execution);
vi.mock("../src/lib/remote-profiles", () => remoteProfiles);

const storage = {
  get: vi.fn(async () => ({})),
  remove: vi.fn(async () => undefined),
  set: vi.fn(async () => undefined),
};

let App: Component;
type TestI18n = Plugin & {
  global: { locale: { value: string } };
};
let i18n: TestI18n;

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
  i18n = (await import("../src/i18n")).i18n as unknown as TestI18n;
});

beforeEach(() => {
  i18n.global.locale.value = "en-US";
  vi.clearAllMocks();
  execution.executeRequest.mockReset();
  execution.browserUnsupportedReasons.mockReset();
  execution.browserUnsupportedReasons.mockReturnValue([]);
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
  remoteProfiles.loadRelayProfiles.mockReset();
  remoteProfiles.loadRelayProfiles.mockResolvedValue([]);
  remoteProfiles.getSessionExecutorSelection.mockReset();
  remoteProfiles.getSessionExecutorSelection.mockResolvedValue("browser");
  remoteProfiles.getRelayToken.mockReset();
  remoteProfiles.getRelayToken.mockResolvedValue(null);
  remoteProfiles.ensureRelayPermission.mockReset();
  remoteProfiles.ensureRelayPermission.mockResolvedValue(undefined);
  remoteProfiles.isRelayTrusted.mockReset();
  remoteProfiles.isRelayTrusted.mockResolvedValue(false);
  remoteProfiles.trustRelayForSession.mockReset();
  remoteProfiles.trustRelayForSession.mockResolvedValue(undefined);
  remoteProfiles.saveRelayProfile.mockReset();
  remoteProfiles.saveRelayProfile.mockImplementation(async (profile) =>
    structuredClone(profile),
  );
  remoteProfiles.testRelayConnection.mockClear();
});

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

describe("Remote Relay selection and progress", () => {
  const profile: RemoteRelayProfileV1 = {
    schemaVersion: 1,
    id: "relay-development",
    name: "Development Relay",
    baseUrl: "https://relay.example.workers.dev",
    tokenStorage: "session",
  };

  it("restores a specific profile only from session storage", async () => {
    remoteProfiles.loadRelayProfiles.mockResolvedValue([profile]);
    remoteProfiles.getSessionExecutorSelection.mockResolvedValue(profile.id);
    const wrapper = await mountApp();

    const executor = wrapper.get('select[aria-label="Executor"]');
    expect((executor.element as HTMLSelectElement).value).toBe(profile.id);
    await executor.setValue("browser");
    await flushPromises();

    expect(remoteProfiles.setSessionExecutorSelection).toHaveBeenCalledWith(
      "browser",
    );
    wrapper.unmount();
  });

  it("requires explicit first-send consent and can trust the profile for the session", async () => {
    remoteProfiles.loadRelayProfiles.mockResolvedValue([profile]);
    remoteProfiles.getSessionExecutorSelection.mockResolvedValue(profile.id);
    remoteProfiles.getRelayToken.mockResolvedValue("relay-secret");
    execution.executeRequest.mockImplementation(async (request) => ({
      ...responseFor(request.id),
      executor: "remote",
    }));
    const wrapper = await mountApp();
    await wrapper
      .get('input[aria-label="Request URL"]')
      .setValue("https://api.example.com/private");

    await wrapper.get("button.send-button").trigger("click");
    await flushPromises();

    expect(execution.executeRequest).not.toHaveBeenCalled();
    expect(remoteProfiles.ensureRelayPermission).toHaveBeenCalledWith(profile);
    expect(
      remoteProfiles.ensureRelayPermission.mock.invocationCallOrder[0],
    ).toBeLessThan(remoteProfiles.getRelayToken.mock.invocationCallOrder[0]!);
    const consent = wrapper.get('[aria-labelledby="remote-consent-title"]');
    expect(consent.text()).toContain("https://api.example.com");
    expect(consent.text()).toContain("relay.example.workers.dev");
    await consent.get('input[type="checkbox"]').setValue(true);
    await consent.get("button.primary-button").trigger("click");
    await flushPromises();

    expect(remoteProfiles.trustRelayForSession).toHaveBeenCalledWith(
      profile,
      "relay-secret",
    );
    expect(remoteProfiles.ensureRelayPermission).toHaveBeenCalledOnce();
    const executeCall = execution.executeRequest.mock.calls[0];
    expect(executeCall?.[0]).toEqual(
      expect.objectContaining({ url: "https://api.example.com/private" }),
    );
    expect(executeCall?.[1]).toEqual(
      expect.objectContaining({
        target: { kind: "remote", profile, token: "relay-secret" },
        relayPermissionAlreadyGranted: true,
      }),
    );
    expect(typeof executeCall?.[1]?.onProgress).toBe("function");
    expect(wrapper.text()).toContain("Remote · 1 ms");
    wrapper.unmount();
  });

  it("keeps Browser selected after creating a relay profile", async () => {
    let savedProfile: RemoteRelayProfileV1 | undefined;
    remoteProfiles.loadRelayProfiles.mockImplementation(async () =>
      savedProfile ? [structuredClone(savedProfile)] : [],
    );
    remoteProfiles.saveRelayProfile.mockImplementation(async (candidate) => {
      savedProfile = structuredClone(candidate);
      return structuredClone(candidate);
    });
    const wrapper = await mountApp();
    const executor = wrapper.get('select[aria-label="Executor"]');
    expect((executor.element as HTMLSelectElement).value).toBe("browser");

    await wrapper.get("button.relay-manage-button").trigger("click");
    await flushPromises();
    const dialog = wrapper.get('[aria-labelledby="relay-manager-title"]');
    const fields = dialog.findAll("input.field");
    await fields[0]!.setValue("New relay");
    await fields[1]!.setValue("https://new-relay.example");
    await fields[2]!.setValue("new-relay-token");
    await dialog.get("button.primary-button").trigger("click");
    await flushPromises();

    expect(savedProfile).toMatchObject({
      name: "New relay",
      baseUrl: "https://new-relay.example",
      tokenStorage: "session",
    });
    expect((executor.element as HTMLSelectElement).value).toBe("browser");
    expect(remoteProfiles.setSessionExecutorSelection).not.toHaveBeenCalledWith(
      savedProfile?.id,
    );
    wrapper.unmount();
  });

  it("migrates an existing token when storage changes and the token field stays blank", async () => {
    let profiles = [structuredClone(profile)];
    remoteProfiles.loadRelayProfiles.mockImplementation(async () =>
      structuredClone(profiles),
    );
    remoteProfiles.getRelayToken.mockResolvedValue("existing-session-token");
    remoteProfiles.saveRelayProfile.mockImplementation(async (candidate) => {
      profiles = [structuredClone(candidate)];
      return structuredClone(candidate);
    });
    const wrapper = await mountApp();

    await wrapper.get("button.relay-manage-button").trigger("click");
    await flushPromises();
    const dialog = wrapper.get('[aria-labelledby="relay-manager-title"]');
    await dialog.get('input[type="radio"][value="local"]').setValue(true);
    await dialog.get('input[type="checkbox"]').setValue(true);
    await dialog.get("button.primary-button").trigger("click");
    await flushPromises();

    expect(remoteProfiles.getRelayToken).toHaveBeenCalledWith(profile);
    expect(remoteProfiles.saveRelayProfile).toHaveBeenCalledWith(
      expect.objectContaining({ id: profile.id, tokenStorage: "local" }),
      "existing-session-token",
    );
    expect(
      (
        wrapper.get('select[aria-label="Executor"]')
          .element as HTMLSelectElement
      ).value,
    ).toBe("browser");
    wrapper.unmount();
  });

  it("preflights relay permission once before a connection test", async () => {
    remoteProfiles.loadRelayProfiles.mockResolvedValue([profile]);
    remoteProfiles.getRelayToken.mockResolvedValue("relay-secret");
    const wrapper = await mountApp();

    await wrapper.get("button.relay-manage-button").trigger("click");
    await flushPromises();
    const dialog = wrapper.get('[aria-labelledby="relay-manager-title"]');
    const testConnection = dialog
      .findAll("button")
      .find((button) => button.text().includes("Test connection"));
    if (!testConnection) throw new Error("Expected Test connection button.");
    await testConnection.trigger("click");
    await flushPromises();

    expect(remoteProfiles.ensureRelayPermission).toHaveBeenCalledOnce();
    expect(remoteProfiles.testRelayConnection).toHaveBeenCalledWith(
      profile,
      "relay-secret",
      { force: true, permissionAlreadyGranted: true },
    );
    wrapper.unmount();
  });

  it("stops before reading tokens when relay host permission is denied", async () => {
    remoteProfiles.loadRelayProfiles.mockResolvedValue([profile]);
    remoteProfiles.getSessionExecutorSelection.mockResolvedValue(profile.id);
    remoteProfiles.ensureRelayPermission.mockRejectedValue(
      new Error("Host permission was not granted for relay."),
    );
    const wrapper = await mountApp();
    await wrapper
      .get('input[aria-label="Request URL"]')
      .setValue("https://api.example.com/private");

    await wrapper.get("button.send-button").trigger("click");
    await flushPromises();

    expect(remoteProfiles.getRelayToken).not.toHaveBeenCalled();
    expect(execution.executeRequest).not.toHaveBeenCalled();
    expect(wrapper.get(".message-strip").text()).toContain(
      "permission was not granted",
    );
    wrapper.unmount();
  });

  it("consumes consent once when the confirm action is triggered twice", async () => {
    remoteProfiles.loadRelayProfiles.mockResolvedValue([profile]);
    remoteProfiles.getSessionExecutorSelection.mockResolvedValue(profile.id);
    remoteProfiles.getRelayToken.mockResolvedValue("relay-secret");
    let resolveTrust!: () => void;
    remoteProfiles.trustRelayForSession.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveTrust = resolve;
        }),
    );
    execution.executeRequest.mockImplementation(async (request) => ({
      ...responseFor(request.id),
      executor: "remote",
    }));
    const wrapper = await mountApp();
    await wrapper
      .get('input[aria-label="Request URL"]')
      .setValue("https://api.example.com/private");
    await wrapper.get("button.send-button").trigger("click");
    await flushPromises();
    const consent = wrapper.get('[aria-labelledby="remote-consent-title"]');
    await consent.get('input[type="checkbox"]').setValue(true);
    const confirm = consent.get("button.primary-button");

    const firstClick = confirm.trigger("click");
    const secondClick = confirm.trigger("click");
    await Promise.all([firstClick, secondClick]);
    await vi.waitFor(() =>
      expect(remoteProfiles.trustRelayForSession).toHaveBeenCalledOnce(),
    );
    expect(confirm.attributes()).toHaveProperty("disabled");
    resolveTrust();
    await flushPromises();

    expect(execution.executeRequest).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it("shows measured download progress and disables repeated Stop clicks", async () => {
    let rejectExecution!: (reason: Error) => void;
    execution.executeRequest.mockImplementation((_request, options) => {
      options?.onProgress?.({
        phase: "downloading",
        loadedBytes: 4_096,
        totalBytes: 8_192,
        elapsedMs: 25,
      });
      return new Promise<ResponseRecordV1>((_resolve, reject) => {
        rejectExecution = reject;
      });
    });
    const wrapper = await mountApp();
    await wrapper
      .get('input[aria-label="Request URL"]')
      .setValue("https://example.com/large");

    await wrapper.get("button.send-button").trigger("click");
    await wrapper.vm.$nextTick();

    const progress = wrapper.get('[role="progressbar"]');
    expect(progress.text()).toContain("Downloading response");
    expect(progress.attributes("aria-valuenow")).toBe("4096");
    const stop = wrapper.get("button.stop-button");
    await stop.trigger("click");
    await wrapper.vm.$nextTick();

    expect(execution.cancelRequest).toHaveBeenCalledOnce();
    expect(stop.attributes()).toHaveProperty("disabled");
    expect(wrapper.text()).toContain("Cancelling");
    await stop.trigger("click");
    expect(execution.cancelRequest).toHaveBeenCalledOnce();

    rejectExecution(new Error("Request cancelled"));
    await flushPromises();
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("Request cancelled");
    wrapper.unmount();
  });

  it("offers one-send filtering without mutating the imported request", async () => {
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
    execution.browserUnsupportedReasons.mockImplementation((request) =>
      request.headers.some(
        (header) => header.enabled && header.name.toLowerCase() === "dnt",
      )
        ? ["the forbidden DNT header"]
        : [],
    );
    execution.executeRequest.mockImplementation(async (request) =>
      responseFor(request.id),
    );

    await wrapper.get("button.send-button").trigger("click");
    await wrapper.vm.$nextTick();
    const dialog = wrapper.get(
      '[aria-labelledby="browser-compatibility-title"]',
    );
    expect(dialog.text()).toContain("the forbidden DNT header");
    const filter = dialog
      .findAll("button")
      .find((button) => button.text().includes("Filter once and send"));
    if (!filter) throw new Error("Expected one-send filtering action.");
    await filter.trigger("click");
    await flushPromises();

    expect(execution.executeRequest.mock.calls[0]?.[0].headers).toEqual([]);
    expect(store.current.headers).toEqual([
      expect.objectContaining({ name: "DNT", value: "1" }),
    ]);
    wrapper.unmount();
  });
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
