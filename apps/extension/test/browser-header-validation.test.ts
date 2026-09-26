// @vitest-environment node
import { createDefaultRequest } from "@xpanel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  executeBrowser,
  sanitizeBrowserRequestHeaders,
} from "../src/lib/execute";
import {
  browserRequestHeaders,
  browserUnsupportedReasons,
} from "../src/lib/execution/browser-headers";
import { firstBrowserHeaderIssue } from "../src/lib/execution/browser-header-validation";

afterEach(() => vi.unstubAllGlobals());

describe("Browser header syntax", () => {
  it.each([
    "Bad Name",
    " X-Test",
    "X-Test ",
    "X:Test",
    "X-Test\n",
    "X\rTest",
    "中文",
    "",
    ":unknown",
  ])(
    "rejects invalid names before permission/network access: %j",
    async (name) => {
      const request = createDefaultRequest({
        url: "https://example.invalid/",
        headers: [{ name, value: "secret-canary", enabled: true }],
      });
      const fetch = vi.fn();
      const permission = vi.fn();
      vi.stubGlobal("fetch", fetch);
      vi.stubGlobal("chrome", { permissions: { request: permission } });
      const error = await executeBrowser(request).catch(
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("Headers[1]");
      expect((error as Error).message).not.toContain("secret-canary");
      expect(fetch).not.toHaveBeenCalled();
      expect(permission).not.toHaveBeenCalled();
    },
  );

  it.each(["secret\r\ninjected", "secret\0value", "中文", "🙂"])(
    "rejects invalid values without revealing them",
    (value) => {
      const request = createDefaultRequest({
        headers: [{ name: "X-Test", value, enabled: true }],
      });
      expect(firstBrowserHeaderIssue(request)).toEqual({
        kind: "value",
        location: "Headers[1]",
      });
      expect(() => browserRequestHeaders(request)).toThrow(
        "invalid Browser header value",
      );
    },
  );

  it("filters captured pseudo-headers only in the execution copy", () => {
    const names = [":authority", ":method", ":path", ":scheme", ":status"];
    const request = createDefaultRequest({
      headers: [
        ...names.map((name) => ({ name, value: "captured", enabled: true })),
        { name: "X-Test", value: "kept", enabled: true },
      ],
    });
    expect(browserUnsupportedReasons(request)).toHaveLength(5);
    const filtered = sanitizeBrowserRequestHeaders(request);
    expect(filtered.removedHeaders.map((item) => item.name)).toEqual(names);
    expect([...browserRequestHeaders(filtered.request)]).toEqual([
      ["x-test", "kept"],
    ]);
    expect(request.headers).toHaveLength(6);
  });

  it("keeps duplicate valid headers and ignores disabled/empty placeholder rows", () => {
    const request = createDefaultRequest({
      headers: [
        { name: "", value: "", enabled: true },
        { name: "invalid name", value: "ignored", enabled: false },
        { name: "X-Test", value: "a", enabled: true },
        { name: "X-Test", value: "b", enabled: true },
      ],
    });
    expect(firstBrowserHeaderIssue(request)).toBeUndefined();
    expect(browserRequestHeaders(request).get("X-Test")).toBe("a, b");
    expect(
      firstBrowserHeaderIssue({
        ...request,
        auth: {
          kind: "api-key",
          location: "header",
          name: "Bad Key",
          value: "secret",
        },
      }),
    ).toEqual({ kind: "name", location: "Auth" });
    expect(
      firstBrowserHeaderIssue({
        ...request,
        auth: { kind: "bearer", token: "secret\nvalue" },
      }),
    ).toEqual({ kind: "value", location: "Auth" });
  });
});
