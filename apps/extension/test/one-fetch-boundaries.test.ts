import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeRequestMetadata,
  type OneFetchCapabilitiesV1,
} from "@one-fetch/protocol";
import { createDefaultRequest } from "@xpanel/contracts";
import { executeRemote } from "../src/lib/execute";
import { openRemoteResponse } from "../src/lib/execution/remote";
import { bindFile } from "../src/lib/file-bindings";
import {
  capabilities,
  consent,
  fetchInputUrl,
  profile,
  signedResponse,
  token,
} from "./one-fetch.fixture";

const limit = 20 * 1024 * 1024;
const target = () => ({
  kind: "remote" as const,
  profile: profile(),
  token,
  consent,
});
const request = () => ({
  ...createDefaultRequest(),
  url: "https://target.example/test",
});
function transport(
  handler: (init: RequestInit) => Promise<Response>,
  caps = capabilities(),
) {
  const mock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
    fetchInputUrl(url).endsWith("/api/v1/capabilities")
      ? Response.json(caps)
      : handler(init ?? {}),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}
beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal("chrome", {
    runtime: {},
    permissions: { request: async () => true },
  });
});
describe("one-fetch fidelity and response limits", () => {
  it.each([limit, limit + 1])(
    "enforces the 20 MiB response boundary with unknown length (%i bytes)",
    async (size) => {
      transport(async (init) => signedResponse(init, "x".repeat(size)));
      const response = await openRemoteResponse(request(), target());
      if (size > limit)
        await expect(
          new Response(response.stream).arrayBuffer(),
        ).rejects.toThrow("limit");
      else {
        expect(
          (await new Response(response.stream).arrayBuffer()).byteLength,
        ).toBe(limit);
        await response.finalizeRemote!();
      }
    },
  );
  it("takes the smaller user/service limit and rejects oversized request bodies before Gateway fetch", async () => {
    transport(async (init) =>
      signedResponse(init, "x".repeat(1024 * 1024 + 1)),
    );
    const response = await openRemoteResponse(request(), target(), {
      maximumResponseBytes: 1024 * 1024,
    });
    await expect(new Response(response.stream).arrayBuffer()).rejects.toThrow(
      "limit",
    );
    const fetch = transport(async (init) => signedResponse(init), {
      ...capabilities(),
      limits: { ...capabilities().limits, requestBodyBytes: 10 },
    });
    await expect(
      executeRemote(
        {
          ...request(),
          method: "POST",
          body: { kind: "text", text: "x".repeat(11) },
        },
        target(),
      ),
    ).rejects.toThrow("service limit");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("forwards selected multipart bytes, deterministic boundary and custom part headers", async () => {
    const file = new File([new Uint8Array([0, 1, 255])], "synthetic.bin", {
      type: "application/octet-stream",
    });
    const ref = {
      id: crypto.randomUUID(),
      name: file.name,
      size: file.size,
      requiresReselection: false,
    };
    bindFile(ref, file);
    transport(async (init) => {
      const meta = decodeRequestMetadata(
        new Headers(init.headers).get("One-Fetch-Request")!,
      );
      const body = await new Response(init.body).arrayBuffer();
      expect(body.byteLength).toBe(meta.body.sizeBytes);
      expect(
        meta.targetHeaders.find((h) => h.name === "Content-Type")?.value,
      ).toMatch(/^multipart\/form-data; boundary=----xpanel-/u);
      expect(new TextDecoder().decode(body)).toContain("X-Part: synthetic");
      expect(new Uint8Array(body)).toContain(255);
      return signedResponse(init);
    });
    await executeRemote(
      {
        ...request(),
        method: "POST",
        body: {
          kind: "multipart",
          parts: [
            { kind: "text", name: "label", value: "synthetic", enabled: true },
            {
              kind: "file",
              name: "file",
              file: ref,
              enabled: true,
              headers: [{ name: "X-Part", value: "synthetic", enabled: true }],
            },
          ],
        },
      },
      target(),
    );
  });
  it("uses official Supabase path binding and declares accepted provider mutations", async () => {
    const caps: OneFetchCapabilitiesV1 = {
      ...capabilities(),
      provider: "supabase",
      fetchOptions: [
        ...capabilities().fetchOptions,
        { option: "adapter.supabaseAcceptMutations", fidelity: "translated" },
        { option: "adapter.supabaseOriginalPathV1", fidelity: "exact" },
      ],
    };
    transport(async (init) => {
      const meta = decodeRequestMetadata(
        new Headers(init.headers).get("One-Fetch-Request")!,
      );
      expect(meta.fetchOptions.adapter?.supabaseAcceptMutations).toBe(true);
      expect(meta.fetchOptions.adapter?.supabaseOriginalPathV1).toBe(
        "/v1//a%2Fb?x=%20&x=2",
      );
      return signedResponse(init);
    }, caps);
    await executeRemote(
      { ...request(), url: "https://target.example/v1//a%2Fb?x=%20&x=2" },
      target(),
    );
  });
  it("blocks unsupported Fetch options and sends deny rules without mutating saved requests", async () => {
    const caps = capabilities();
    caps.fetchOptions[0] = { option: "redirect", fidelity: "unsupported" };
    const fetch = transport(async (init) => signedResponse(init), caps);
    await expect(executeRemote(request(), target())).rejects.toThrow(
      "Fetch options",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    const configured = target();
    configured.profile.userDenyRules.rules.push({
      id: "deny",
      name: "Deny DELETE",
      enabled: true,
      action: "deny",
      match: { methods: ["DELETE"] },
    });
    transport(async (init) => {
      const meta = decodeRequestMetadata(
        new Headers(init.headers).get("One-Fetch-Request")!,
      );
      expect(meta.userDenyRules).toEqual(configured.profile.userDenyRules);
      return signedResponse(init);
    });
    const input = request();
    await executeRemote(input, configured);
    expect(input).not.toHaveProperty("userDenyRules");
  });
});
