import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultRequest } from "@xpanel/contracts";
import { openRemoteResponse } from "../src/lib/execution/remote";
import {
  capabilities,
  consent,
  fetchInputUrl,
  profile,
  signedResponse,
  token,
} from "./one-fetch.fixture";

const request = () => ({
  ...createDefaultRequest(),
  url: "https://target.example/status/302",
});
const target = () => ({
  kind: "remote" as const,
  profile: profile(),
  token,
  consent,
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal("chrome", {
    permissions: { request: vi.fn(async () => true) },
  });
});

describe("required one-fetch browser envelope", () => {
  it.each(["missing", "unsupported", "wrong-value", "unbounded"])(
    "rejects %s negotiation before Gateway access, without sending credentials to discovery",
    async (mode) => {
      const caps = capabilities();
      caps.fetchOptions = caps.fetchOptions.filter(
        (item) => item.option !== "adapter.browserResponse",
      );
      if (mode !== "missing")
        caps.fetchOptions.push({
          option: "adapter.browserResponse",
          fidelity: mode === "unsupported" ? "unsupported" : "translated",
          ...(mode === "unbounded"
            ? {}
            : {
                acceptedValues: [
                  mode === "wrong-value" ? "other" : "envelope-v1",
                ],
              }),
        });
      const transport = vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          expect(new Headers(init?.headers).has("Authorization")).toBe(false);
          return Response.json(caps);
        },
      );
      vi.stubGlobal("fetch", transport);
      await expect(openRemoteResponse(request(), target())).rejects.toThrow(
        "browser response envelope",
      );
      expect(transport).toHaveBeenCalledTimes(1);
      expect(fetchInputUrl(transport.mock.calls[0]![0])).toContain(
        "/api/v1/capabilities",
      );
    },
  );

  it.each(["missing-mode", "outer-status"])(
    "does not accept a signed %s substitution as a target",
    async (mode) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          if (fetchInputUrl(input).endsWith("/api/v1/capabilities"))
            return Response.json(capabilities());
          const signed = await signedResponse(init ?? {}, "diagnostic", {
            ...(mode === "missing-mode" ? { responseMode: undefined } : {}),
          });
          return mode === "outer-status"
            ? new Response(signed.body, {
                status: 503,
                headers: signed.headers,
              })
            : signed;
        }),
      );
      const response = await openRemoteResponse(request(), target());
      expect(response.remoteDetails?.source).toBe("intermediary");
      await new Response(response.stream).text();
      expect((await response.finalizeRemote!()).integrity).toBe("unverified");
    },
  );
});
