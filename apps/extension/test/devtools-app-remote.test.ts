import { flushPromises } from "@vue/test-utils";
import { createPinia } from "pinia";
import { describe, expect, it, vi } from "vitest";

import {
  type RemoteRelayProfileV1,
  type ResponseRecordV1,
} from "@xpanel/contracts";

import { useWorkbenchStore } from "../src/stores/workbench";
import {
  execution,
  mountApp,
  remoteProfiles,
  responseFor,
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
