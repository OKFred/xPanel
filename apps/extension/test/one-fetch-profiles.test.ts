import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteLegacyRelayProfile,
  deleteRelayProfile,
  ensureRelayPermission,
  getRelayToken,
  getSessionExecutorSelection,
  isRelayTrusted,
  loadLegacyRelayProfiles,
  loadRelayProfiles,
  relayPermissionOrigins,
  saveRelayProfile,
  setSessionExecutorSelection,
  testRelayConnection,
  trustRelayForSession,
  validateRelayProfile,
} from "../src/lib/one-fetch-profiles";
import { assertSameConsent } from "../src/lib/one-fetch-connection";
import {
  capabilities,
  consent,
  profile,
  fetchInputUrl,
} from "./one-fetch.fixture";

function storage() {
  const values: Record<string, unknown> = {};
  const area = {
    get: vi.fn(async (key: string) => ({
      [key]: structuredClone(values[key]),
    })),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(values, structuredClone(items));
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of typeof keys === "string" ? [keys] : keys)
        delete values[key];
    }),
  };
  return { values, area };
}
let local: ReturnType<typeof storage>;
let session: ReturnType<typeof storage>;
let permissionGranted = true;
beforeEach(() => {
  vi.restoreAllMocks();
  local = storage();
  session = storage();
  permissionGranted = true;
  vi.stubGlobal("chrome", {
    storage: { local: local.area, session: session.area },
    permissions: {
      request: vi.fn(async () => permissionGranted),
      contains: vi.fn(async () => permissionGranted),
    },
  });
});

describe("one-fetch profile and credential isolation", () => {
  it("keeps session tokens out of local profiles and exports, explicitly moves persistent tokens", async () => {
    const first = await saveRelayProfile(profile(), "session-canary");
    const second = await saveRelayProfile(
      { ...profile(), name: "Second", tokenStorage: "local" },
      "local-canary",
    );
    expect(await loadRelayProfiles()).toEqual([first, second]);
    expect(JSON.stringify(local.values)).not.toContain("session-canary");
    expect(JSON.stringify(local.values.oneFetchProfilesV1)).not.toContain(
      "local-canary",
    );
    const moved = await saveRelayProfile({ ...first, tokenStorage: "local" });
    expect(await getRelayToken(moved)).toBe("session-canary");
    expect(JSON.stringify(session.values)).not.toContain("session-canary");
    await deleteRelayProfile(second.id);
    expect(JSON.stringify(local.values)).not.toContain("local-canary");
  });
  it("requires a token, case-insensitive unique names and explicit loopback approval", async () => {
    const saved = await saveRelayProfile(profile(), "token");
    expect(() =>
      validateRelayProfile(
        { ...profile(), name: ` ${saved.name.toUpperCase()} ` },
        [saved],
      ),
    ).toThrow("already exists");
    await expect(
      saveRelayProfile({ ...profile(), name: "Missing token" }),
    ).rejects.toThrow("token is required");
    expect(() =>
      validateRelayProfile({
        ...profile(),
        controlUrl: "http://127.0.0.1:3000",
      }),
    ).toThrow();
  });
  it("never revives trust on token, address, rules, instance, version or config changes", async () => {
    const saved = await saveRelayProfile(profile(), "token");
    await trustRelayForSession(saved, "token", consent);
    expect(await isRelayTrusted(saved, "token", consent)).toBe(true);
    expect(await isRelayTrusted(saved, "changed", consent)).toBe(false);
    for (const field of [
      "instanceId",
      "pairId",
      "configVersion",
      "buildVersion",
    ] as const) {
      expect(
        await isRelayTrusted(saved, "token", {
          ...consent,
          [field]: "changed",
        }),
      ).toBe(false);
    }
    const edited = await saveRelayProfile({
      ...saved,
      gatewayUrl: "https://other.example",
    });
    expect(await isRelayTrusted(edited, "token", consent)).toBe(false);
    await saveRelayProfile(saved);
    expect(await isRelayTrusted(saved, "token", consent)).toBe(false);
    expect(JSON.stringify(session.values.oneFetchTrustV1)).not.toContain(
      '"token"',
    );
  });
  it("accepts semantically identical consent regardless of field order", () => {
    const { buildVersion, configVersion, pairId, instanceId } = consent;
    expect(() =>
      assertSameConsent(
        { buildVersion, configVersion, pairId, instanceId },
        capabilities(),
      ),
    ).not.toThrow();
  });
  it("does not reuse legacy profiles, tokens or executor selection; cleanup is scoped", async () => {
    const legacy = {
      schemaVersion: 1,
      id: "old",
      name: "Old",
      baseUrl: "https://old.example",
      tokenStorage: "session",
    };
    local.values.remoteRelayProfilesV1 = [legacy];
    local.values.remoteRelayTokensV1 = { old: "old-local", keep: "keep" };
    session.values.remoteRelayTokensV1 = { old: "old-session" };
    session.values.remoteExecutorSelectionV1 = "old";
    expect(await getSessionExecutorSelection()).toBe("browser");
    expect(await loadRelayProfiles()).toEqual([]);
    expect(await loadLegacyRelayProfiles()).toEqual([legacy]);
    const saved = await saveRelayProfile(
      { ...profile(), id: "old" },
      "new-token",
    );
    await deleteLegacyRelayProfile("old");
    expect(await getRelayToken(saved)).toBe("new-token");
    expect(await loadLegacyRelayProfiles()).toEqual([]);
    expect(local.values.remoteRelayTokensV1).toEqual({ keep: "keep" });
    expect(session.values.remoteRelayTokensV1).toEqual({});
    await setSessionExecutorSelection(saved.id);
    await deleteRelayProfile(saved.id);
    expect(await getSessionExecutorSelection()).toBe("browser");
  });
});

describe("capability discovery and exact service permissions", () => {
  it("deduplicates same-origin Supabase Function permissions and never requests target origins", async () => {
    const configured = {
      ...profile(),
      controlUrl: "https://project.supabase.co/functions/v1/control",
      gatewayUrl: "https://project.supabase.co/functions/v1/gateway",
    };
    expect(relayPermissionOrigins(configured)).toEqual([
      "https://project.supabase.co/*",
    ]);
    await ensureRelayPermission(configured);
    expect(chrome.permissions.request).toHaveBeenCalledWith({
      origins: ["https://project.supabase.co/*"],
    });
  });
  it("refreshes public capabilities without sending execution tokens or testing a target", async () => {
    const fetchMock = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        expect(fetchInputUrl(url)).toBe(
          "https://control.example/control/api/v1/capabilities",
        );
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        expect(JSON.stringify(init)).not.toContain("credential-canary");
        expect(init?.credentials).toBe("omit");
        expect(init?.redirect).toBe("error");
        return Response.json(capabilities());
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    await testRelayConnection(profile(), "credential-canary");
    await testRelayConnection(profile(), "credential-canary");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("stops discovery after denied permissions and after revoked offscreen permissions", async () => {
    permissionGranted = false;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(testRelayConnection(profile(), "token")).rejects.toThrow(
      "not granted",
    );
    await expect(
      testRelayConnection(profile(), "token", {
        permissionAlreadyGranted: true,
      }),
    ).rejects.toThrow("no longer granted");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects oversized discovery metadata and unsupported protocol versions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("x".repeat(49153))),
    );
    await expect(testRelayConnection(profile(), "token")).rejects.toThrow(
      "48 KiB",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ ...capabilities(), protocolVersion: 2 }),
      ),
    );
    await expect(testRelayConnection(profile(), "token")).rejects.toThrow();
  });
});
