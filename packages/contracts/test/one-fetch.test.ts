import { describe, expect, it } from "vitest";
import {
  oneFetchProfileV1Schema,
  oneFetchResponseDetailsV1Schema,
} from "../src/one-fetch.js";

const profile = {
  schemaVersion: 1,
  id: "test",
  name: "Hosted",
  tokenStorage: "session",
  controlUrl: "https://example.supabase.co/functions/v1/control",
  gatewayUrl: "https://example.supabase.co/functions/v1/gateway",
};

describe("one-fetch local contracts", () => {
  it("allows separate same-origin function prefixes and defaults to no user rules", () => {
    expect(oneFetchProfileV1Schema.parse(profile).userDenyRules.rules).toEqual(
      [],
    );
  });
  it.each([
    { controlUrl: "http://example.com" },
    { controlUrl: "https://user:secret@example.com" },
    { controlUrl: "https://example.com/?" },
    { controlUrl: "https://example.com/#" },
    { controlUrl: profile.gatewayUrl },
    { token: "must-not-be-stored-here" },
    { schemaVersion: 2 },
  ])("rejects unsafe/unknown profile data %j", (extra) => {
    expect(
      oneFetchProfileV1Schema.safeParse({ ...profile, ...extra }).success,
    ).toBe(false);
  });
  it("requires explicit opt-in for loopback HTTP, never permits LAN HTTP", () => {
    const local = {
      ...profile,
      controlUrl: "http://localhost:8787",
      gatewayUrl: "http://127.0.0.1:8788",
    };
    expect(oneFetchProfileV1Schema.safeParse(local).success).toBe(false);
    expect(
      oneFetchProfileV1Schema.safeParse({ ...local, allowLoopbackHttp: true })
        .success,
    ).toBe(true);
    expect(
      oneFetchProfileV1Schema.safeParse({
        ...local,
        controlUrl: "http://192.168.1.1",
        allowLoopbackHttp: true,
      }).success,
    ).toBe(false);
  });
  it("cannot give a user rule allow privileges", () => {
    expect(
      oneFetchProfileV1Schema.safeParse({
        ...profile,
        userDenyRules: {
          schemaVersion: 1,
          rules: [
            { id: "x", name: "x", enabled: true, action: "allow", match: {} },
          ],
        },
      }).success,
    ).toBe(false);
  });
  it("rejects credentials in the local response sidecar", () => {
    const details = {
      schemaVersion: 1,
      source: "intermediary",
      outerStatus: 502,
      outerHeaders: [],
      mutations: [],
      audit: "unknown",
      integrity: "unverified",
    };
    expect(oneFetchResponseDetailsV1Schema.safeParse(details).success).toBe(
      true,
    );
    expect(
      oneFetchResponseDetailsV1Schema.safeParse({ ...details, token: "secret" })
        .success,
    ).toBe(false);
  });
  it("allows opaque status only for unverified intermediary diagnostics", () => {
    const details = {
      schemaVersion: 1,
      source: "intermediary",
      outerStatus: 0,
      outerHeaders: [],
      mutations: [],
      audit: "unknown",
      integrity: "unverified",
    };
    expect(oneFetchResponseDetailsV1Schema.safeParse(details).success).toBe(
      true,
    );
    for (const source of ["target", "relay-error"])
      expect(
        oneFetchResponseDetailsV1Schema.safeParse({ ...details, source })
          .success,
      ).toBe(false);
  });
});
