import { afterEach, describe, expect, it, vi } from "vitest";

import { createDefaultRequest } from "@xpanel/contracts";

import { executeBrowser } from "../src/lib/execute";
import { testRelayConnection } from "../src/lib/one-fetch-connection";
import { capabilities, profile, token } from "./one-fetch.fixture";

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

  it("loads one-fetch capabilities without chrome.permissions after preflight", async () => {
    vi.stubGlobal("chrome", {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve(
          new Response(JSON.stringify(capabilities()), {
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    );

    await expect(
      testRelayConnection(profile(), token, { permissionPreflighted: true }),
    ).resolves.toMatchObject({ provider: "node", buildVersion: "0.1.2" });
    // Discovery is public: no execution credential accompanies this request.
    const headers = new Headers(vi.mocked(fetch).mock.calls[0]?.[1]?.headers);
    expect(headers.has("authorization")).toBe(false);
  });

  it("asks the service worker about an approved cross-origin redirect", async () => {
    const sendMessage = vi.fn(
      async (message: { commandId: string; origin: string }) => ({
        channel: "xpanel.execution.permission.v1",
        commandId: message.commandId,
        granted: message.origin === "https://redirected.example.test",
      }),
    );
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(null, {
            status: 302,
            headers: {
              location: "https://redirected.example.test/items",
            },
          }),
        )
        .mockResolvedValueOnce(
          new Response('{"redirected":true}', {
            headers: { "content-type": "application/json" },
          }),
        ),
    );

    const response = await executeBrowser(
      createDefaultRequest({
        id: "offscreen-redirect",
        url: "https://api.example.test/items",
      }),
      { browserPermissionPreflighted: true },
    );

    expect(response.status).toBe(200);
    expect(response.body.content).toBe('{"redirected":true}');
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "xpanel.execution.permission.v1",
        origin: "https://redirected.example.test",
      }),
    );
  });
});
