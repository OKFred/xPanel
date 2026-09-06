import { afterEach, describe, expect, it, vi } from "vitest";

import { createDefaultRequest } from "@xpanel/contracts";

import { executeBrowser } from "../src/lib/execute";
import { testRelayConnection } from "../src/lib/remote-profiles";

afterEach(() => vi.unstubAllGlobals());

describe("offscreen permission preflight", () => {
  it("runs Browser Fetch without chrome.permissions after a visible-page grant", async () => {
    vi.stubGlobal("chrome", {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve(
          new Response('{"ok":true}', {
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    );

    const response = await executeBrowser(
      createDefaultRequest({
        id: "offscreen-browser",
        url: "https://api.example.test/items",
      }),
      { browserPermissionPreflighted: true },
    );

    expect(response.status).toBe(200);
    expect(response.body.content).toBe('{"ok":true}');
  });

  it("loads Relay capabilities without chrome.permissions after preflight", async () => {
    vi.stubGlobal("chrome", {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
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
            }),
            { headers: { "content-type": "application/json" } },
          ),
        ),
      ),
    );

    await expect(
      testRelayConnection(
        {
          schemaVersion: 1,
          id: "offscreen-relay",
          name: "Offscreen relay",
          baseUrl: "https://relay.example.test",
          tokenStorage: "session",
        },
        "secret-token",
        { force: true, permissionPreflighted: true },
      ),
    ).resolves.toMatchObject({ provider: "cloudflare" });
  });
});
