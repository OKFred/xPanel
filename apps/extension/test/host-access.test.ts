import { flushPromises, mount } from "@vue/test-utils";
import type { Plugin } from "vue";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ALL_HTTP_HOST_ORIGINS,
  grantAllHttpHostAccess,
  hasAllHttpHostAccess,
  revokeAllHttpHostAccess,
} from "../src/lib/host-access";
import HostAccessControl from "../src/components/HostAccessControl.vue";

const permissionCalls: string[] = [];
const permissions = {
  contains: vi.fn(async () => {
    permissionCalls.push("contains");
    return false;
  }),
  getAll: vi.fn(async () => {
    permissionCalls.push("getAll");
    return { origins: [] as string[] };
  }),
  remove: vi.fn(async () => {
    permissionCalls.push("remove");
    return true;
  }),
  request: vi.fn(async () => {
    permissionCalls.push("request");
    return true;
  }),
};

type TestI18n = Plugin & {
  global: { locale: { value: string } };
};
let i18n: TestI18n;

beforeAll(async () => {
  vi.stubGlobal("chrome", {
    i18n: { getUILanguage: vi.fn(() => "en-US") },
    permissions,
  });
  i18n = (await import("../src/i18n")).i18n as unknown as TestI18n;
});

describe("HTTP host access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissionCalls.length = 0;
    permissions.contains.mockImplementation(async () => {
      permissionCalls.push("contains");
      return false;
    });
    permissions.getAll.mockImplementation(async () => {
      permissionCalls.push("getAll");
      return { origins: [] };
    });
    permissions.remove.mockImplementation(async () => {
      permissionCalls.push("remove");
      return true;
    });
    permissions.request.mockImplementation(async () => {
      permissionCalls.push("request");
      return true;
    });
    vi.stubGlobal("chrome", {
      i18n: { getUILanguage: vi.fn(() => "en-US") },
      permissions,
    });
    i18n.global.locale.value = "en-US";
  });

  it("checks and requests both optional HTTP schemes", async () => {
    permissions.contains.mockImplementation(async () => {
      permissionCalls.push("contains");
      return true;
    });

    await expect(hasAllHttpHostAccess()).resolves.toBe(true);
    await expect(grantAllHttpHostAccess()).resolves.toBe(true);

    const expected = { origins: [...ALL_HTTP_HOST_ORIGINS] };
    expect(permissions.contains).toHaveBeenCalledWith(expected);
    expect(permissions.request).toHaveBeenCalledWith(expected);
  });

  it("revokes broad and exact HTTP grants without touching other origins", async () => {
    permissions.getAll.mockImplementation(async () => {
      permissionCalls.push("getAll");
      return {
        origins: [
          "http://*/*",
          "https://api.example/*",
          "ftp://files.example/*",
        ],
      };
    });

    await expect(revokeAllHttpHostAccess()).resolves.toBe(true);
    expect(permissions.remove).toHaveBeenCalledWith({
      origins: ["http://*/*", "https://api.example/*"],
    });
  });

  it("grants all sites from one explicit click and can return to per-domain mode", async () => {
    const wrapper = mount(HostAccessControl, {
      global: { plugins: [i18n] },
    });
    await flushPromises();

    expect(wrapper.text()).toContain("Ask per domain");
    expect(wrapper.get("button").attributes("aria-describedby")).toBe(
      "xpanel-host-access-hint",
    );
    permissionCalls.length = 0;
    await wrapper.get("button").trigger("click");
    await flushPromises();

    expect(permissionCalls).toEqual(["request"]);
    expect(permissions.request).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain("All HTTP/HTTPS sites allowed");
    expect(wrapper.get('[role="status"]').text()).toContain("enabled");

    permissions.getAll.mockImplementation(async () => {
      permissionCalls.push("getAll");
      return { origins: [...ALL_HTTP_HOST_ORIGINS] };
    });
    await wrapper.get("button").trigger("click");
    await flushPromises();

    expect(permissions.remove).toHaveBeenCalledWith({
      origins: [...ALL_HTTP_HOST_ORIGINS],
    });
    expect(wrapper.text()).toContain("Ask per domain");
    wrapper.unmount();
  });

  it("does not let a stale initial permission check overwrite a grant", async () => {
    let resolveContains: ((value: boolean) => void) | undefined;
    permissions.contains.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          permissionCalls.push("contains");
          resolveContains = resolve;
        }),
    );
    const wrapper = mount(HostAccessControl, {
      global: { plugins: [i18n] },
    });

    await wrapper.get("button").trigger("click");
    await flushPromises();
    resolveContains?.(false);
    await flushPromises();

    expect(wrapper.text()).toContain("All HTTP/HTTPS sites allowed");
    wrapper.unmount();
  });

  it("keeps per-domain mode when Chrome denies the broad grant", async () => {
    permissions.request.mockImplementation(async () => {
      permissionCalls.push("request");
      return false;
    });
    const wrapper = mount(HostAccessControl, {
      global: { plugins: [i18n] },
    });
    await flushPromises();

    await wrapper.get("button").trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("keep asking per domain");
    expect(wrapper.text()).toContain("Ask per domain");
    expect(wrapper.get('[role="alert"]').text()).toContain(
      "keep asking per domain",
    );
    wrapper.unmount();
  });
});
