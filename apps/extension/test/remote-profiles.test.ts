import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  REMOTE_MAX_METADATA_BYTES,
  REMOTE_MAX_REQUEST_BODY_BYTES,
  REMOTE_MAX_RESPONSE_BODY_BYTES,
  type RemoteRelayProfileV1,
} from "@xpanel/contracts";

import {
  deleteRelayProfile,
  ensureRelayPermission,
  getRelayToken,
  getSessionExecutorSelection,
  isRelayTrusted,
  loadRelayProfiles,
  normalizeRelayBaseUrl,
  saveRelayProfile,
  setSessionExecutorSelection,
  testRelayConnection,
  trustRelayForSession,
  validateRelayProfile,
} from "../src/lib/remote-profiles";

function storageArea(seed: Record<string, unknown> = {}): {
  area: chrome.storage.StorageArea;
  values: Record<string, unknown>;
} {
  const values = structuredClone(seed);
  return {
    values,
    area: {
      get: vi.fn(async (keys?: string | string[] | null) => {
        if (keys === undefined || keys === null) return structuredClone(values);
        const selected = typeof keys === "string" ? [keys] : keys;
        return Object.fromEntries(
          selected
            .filter((key) => key in values)
            .map((key) => [key, structuredClone(values[key])]),
        );
      }),
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(values, structuredClone(items));
      }),
      remove: vi.fn(async (keys: string | string[]) => {
        for (const key of typeof keys === "string" ? [keys] : keys) {
          delete values[key];
        }
      }),
    } as unknown as chrome.storage.StorageArea,
  };
}

function profile(
  overrides: Partial<RemoteRelayProfileV1> = {},
): RemoteRelayProfileV1 {
  return {
    schemaVersion: 1,
    id: "relay-one",
    name: "Production relay",
    baseUrl: "https://relay.example/xpanel",
    tokenStorage: "session",
    ...overrides,
  };
}

function capabilities(): Record<string, unknown> {
  return {
    protocolVersion: 1,
    provider: "cloudflare",
    targetPolicy: "public-https",
    maxMetadataBytes: REMOTE_MAX_METADATA_BYTES,
    maxRequestBodyBytes: REMOTE_MAX_REQUEST_BODY_BYTES,
    maxResponseBodyBytes: REMOTE_MAX_RESPONSE_BODY_BYTES,
    features: {
      explicitCookie: true,
      responseSetCookie: true,
      files: true,
      multipart: true,
      proxy: false,
      customTls: false,
      clientCertificate: false,
    },
  };
}

let local: ReturnType<typeof storageArea>;
let session: ReturnType<typeof storageArea>;

beforeEach(() => {
  vi.restoreAllMocks();
  local = storageArea();
  session = storageArea();
  vi.stubGlobal("chrome", {
    storage: { local: local.area, session: session.area },
    permissions: { request: vi.fn(async () => true) },
  });
});

describe("Remote relay profiles", () => {
  it("normalizes trailing slashes but rejects query and fragment delimiters", () => {
    expect(normalizeRelayBaseUrl(" https://relay.example/path/// ")).toBe(
      "https://relay.example/path",
    );
    expect(() => normalizeRelayBaseUrl("https://relay.example/?")).toThrow(
      "query or fragment",
    );
    expect(() => normalizeRelayBaseUrl("https://relay.example/#")).toThrow(
      "query or fragment",
    );
  });

  it("validates case-insensitive unique profile names", () => {
    expect(() =>
      validateRelayProfile(
        profile({ id: "second", name: " production RELAY " }),
        [profile()],
      ),
    ).toThrow("already exists");
    expect(validateRelayProfile(profile(), [profile()])).toEqual(profile());
  });

  it("stores multiple profiles and keeps tokens in the selected storage area", async () => {
    const first = await saveRelayProfile(profile(), "session-secret");
    const second = await saveRelayProfile(
      profile({
        id: "relay-two",
        name: "Persistent relay",
        baseUrl: "https://other.example",
        tokenStorage: "local",
      }),
      "local-secret",
    );

    expect(await loadRelayProfiles()).toEqual([first, second]);
    expect(await getRelayToken(first)).toBe("session-secret");
    expect(await getRelayToken(second)).toBe("local-secret");
    expect(JSON.stringify(local.values)).toContain("local-secret");
    expect(JSON.stringify(local.values)).not.toContain("session-secret");
    expect(JSON.stringify(session.values)).toContain("session-secret");
  });

  it("migrates an unchanged token when local persistence is explicitly enabled", async () => {
    const saved = await saveRelayProfile(profile(), "secret");
    const persistent = await saveRelayProfile({
      ...saved,
      tokenStorage: "local",
    });

    expect(await getRelayToken(persistent)).toBe("secret");
    expect(JSON.stringify(local.values)).toContain("secret");
    expect(JSON.stringify(session.values)).not.toContain("secret");
  });

  it("stores a concrete profile selection for the browser session", async () => {
    expect(await getSessionExecutorSelection()).toBe("browser");
    await saveRelayProfile(profile(), "secret");
    await setSessionExecutorSelection("relay-one");
    expect(await getSessionExecutorSelection()).toBe("relay-one");

    await deleteRelayProfile("relay-one");
    expect(await getSessionExecutorSelection()).toBe("browser");
    expect(await getRelayToken(profile())).toBeUndefined();
  });

  it("revokes trust when a connection changes and does not revive it on revert", async () => {
    const saved = await saveRelayProfile(profile(), "secret-one");
    await trustRelayForSession(saved, "secret-one");
    expect(await isRelayTrusted(saved, "secret-one")).toBe(true);

    const changed = await saveRelayProfile(
      { ...saved, baseUrl: "https://changed.example" },
      "secret-one",
    );
    expect(await isRelayTrusted(changed, "secret-one")).toBe(false);

    const reverted = await saveRelayProfile(saved, "secret-one");
    expect(await isRelayTrusted(reverted, "secret-one")).toBe(false);
  });

  it("requests exact relay access before using the five-minute capability cache", async () => {
    const order: string[] = [];
    const permission = vi.fn(async () => {
      order.push("permission");
      return true;
    });
    vi.stubGlobal("chrome", {
      storage: { local: local.area, session: session.area },
      permissions: { request: permission },
    });
    const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
      order.push("fetch");
      expect(url.toString()).toBe(
        "https://relay.example/xpanel/v1/capabilities",
      );
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer relay-secret",
      );
      expect(
        (init.headers as Record<string, string>)["X-XPanel-Protocol"],
      ).toBe("1");
      return new Response(JSON.stringify(capabilities()), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await testRelayConnection(profile(), "relay-secret");
    await testRelayConnection(profile(), "relay-secret");

    expect(order).toEqual(["permission", "fetch", "permission"]);
    expect(permission).toHaveBeenNthCalledWith(1, {
      origins: ["https://relay.example/*"],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("stops immediately when exact relay access is denied", async () => {
    const requestPermission = vi.fn(async () => false);
    vi.stubGlobal("chrome", {
      storage: { local: local.area, session: session.area },
      permissions: { request: requestPermission },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(ensureRelayPermission(profile())).rejects.toThrow(
      "permission was not granted",
    );
    expect(requestPermission).toHaveBeenCalledWith({
      origins: ["https://relay.example/*"],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a structured relay authentication error without echoing the token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              protocolVersion: 1,
              error: { code: "unauthorized", message: "Invalid relay token" },
            }),
            { status: 401 },
          ),
      ),
    );

    await expect(
      testRelayConnection(profile({ id: "auth-error" }), "top-secret", {
        force: true,
      }),
    ).rejects.toThrow("unauthorized: Invalid relay token");
    await expect(
      testRelayConnection(profile({ id: "auth-error-2" }), "top-secret", {
        force: true,
      }),
    ).rejects.not.toThrow("top-secret");
  });
});
