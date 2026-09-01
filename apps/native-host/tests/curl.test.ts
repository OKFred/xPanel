import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  prepareCurlRequest,
  redirectedRequest,
  sanitizedCurlEnvironment,
} from "../src/curl.js";
import { RequestStagingSession } from "../src/staging.js";
import { requestFixture } from "./fixtures.js";

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("safe curl argument construction", () => {
  it("never delegates redirects to curl", async () => {
    const session = await RequestStagingSession.create("request-1", []);
    try {
      const prepared = await prepareCurlRequest(
        requestFixture({
          options: {
            redirect: "follow",
            cookieMode: "omit",
            timeoutMs: 5_000,
            proxy: null,
            tls: { verify: true },
          },
        }),
        session,
      );
      expect(prepared.args).not.toContain("--location");
      expect(prepared.args).not.toContain("--location-trusted");
    } finally {
      await session.close();
    }
  });

  it("stages raw bodies so curl cannot interpret user-controlled @ paths", async () => {
    const session = await RequestStagingSession.create("request-1", []);
    try {
      const prepared = await prepareCurlRequest(
        requestFixture({
          method: "POST",
          url: "https://example.test/api?literal=$(touch-pwned)",
          headers: [
            {
              name: "X-Literal",
              value: "; rm -rf definitely-not-run",
              enabled: true,
            },
          ],
          body: { kind: "text", text: "@C:\\Windows\\win.ini" },
        }),
        session,
      );
      const dataIndex = prepared.args.indexOf("--data-binary");
      expect(dataIndex).toBeGreaterThan(-1);
      const bodyArgument = prepared.args[dataIndex + 1];
      expect(bodyArgument).toMatch(/^@.*xpanel-native-/);
      expect(bodyArgument).not.toContain("Windows");
      expect(prepared.args).toContain("X-Literal: ; rm -rf definitely-not-run");
      expect(prepared.args).toContain(
        "https://example.test/api?literal=$(touch-pwned)",
      );
      expect(prepared.args).toContain("--globoff");
      expect(await readFile(bodyArgument!.slice(1), "utf8")).toBe(
        "@C:\\Windows\\win.ini",
      );
    } finally {
      await session.close();
    }
  });

  it("rejects header splitting and non-HTTP URL schemes", async () => {
    const session = await RequestStagingSession.create("request-1", []);
    try {
      await expect(
        prepareCurlRequest(
          requestFixture({
            headers: [
              { name: "X-Test", value: "ok\r\n--config secret", enabled: true },
            ],
          }),
          session,
        ),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(
        prepareCurlRequest(
          requestFixture({ url: "file:///etc/passwd" }),
          session,
        ),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    } finally {
      await session.close();
    }
  });

  it("reads multipart files only through an uploaded, purpose-bound transfer", async () => {
    const file = Buffer.from("safe uploaded bytes");
    const fileHash = digest(file);
    const session = await RequestStagingSession.create("request-1", [
      {
        id: "upload-1",
        name: "payload.txt",
        size: file.byteLength,
        sha256: fileHash,
        purpose: "multipart",
      },
    ]);
    try {
      await session.accept({
        requestId: "request-1",
        transferId: "upload-1",
        sequence: 0,
        data: file.toString("base64"),
        eof: true,
      });
      const prepared = await prepareCurlRequest(
        requestFixture({
          method: "POST",
          body: {
            kind: "multipart",
            parts: [
              {
                kind: "file",
                name: "upload",
                enabled: true,
                file: {
                  id: "upload-1",
                  name: "payload.txt",
                  pathHint: "C:\\Windows\\win.ini",
                  requiresReselection: true,
                },
              },
            ],
          },
        }),
        session,
      );
      expect(prepared.args.join("\n")).not.toContain("win.ini");
      const dataPath =
        prepared.args[prepared.args.indexOf("--data-binary") + 1]!.slice(1);
      const multipartBody = await readFile(dataPath);
      expect(multipartBody.includes(file)).toBe(true);
    } finally {
      await session.close();
    }
  });

  it("removes ambient proxy and curl configuration variables", () => {
    expect(
      sanitizedCurlEnvironment({
        PATH: "safe",
        HTTPS_PROXY: "http://untrusted-proxy",
        no_proxy: "*",
        CURL_HOME: "/untrusted",
      }),
    ).toEqual({ PATH: "safe" });
  });

  it("strips every user header and structured credential on a cross-origin redirect", () => {
    const redirected = redirectedRequest(
      requestFixture({
        url: "https://first.example/start",
        headers: [
          { name: "X-API-Key", value: "secret", enabled: true },
          { name: "X-Public-Metadata", value: "also-scoped", enabled: true },
        ],
        auth: { kind: "bearer", token: "bearer-secret" },
      }),
      302,
      "https://second.example/final",
    );
    expect(redirected).toMatchObject({
      url: "https://second.example/final",
      headers: [],
      auth: { kind: "none" },
    });
  });

  it("blocks a cross-origin 307 that would replay a JSON secret", () => {
    expect(() =>
      redirectedRequest(
        requestFixture({
          method: "POST",
          url: "https://first.example/start",
          body: { kind: "json", text: '{"password":"secret"}' },
        }),
        307,
        "https://second.example/final",
      ),
    ).toThrow(/Cross-origin redirect with a reusable request body was blocked/);
  });

  it("does not re-append a query API key on a same-origin redirect", () => {
    const redirected = redirectedRequest(
      requestFixture({
        url: "https://example.test/start",
        auth: {
          kind: "api-key",
          location: "query",
          name: "api_key",
          value: "query-secret",
        },
      }),
      302,
      "/final",
    );
    expect(redirected).toMatchObject({
      url: "https://example.test/final",
      auth: { kind: "none" },
    });
  });

  it("drops a client certificate when a redirect changes origin", () => {
    const file = (id: string) => ({
      id,
      name: `${id}.pem`,
      requiresReselection: true,
    });
    const redirected = redirectedRequest(
      requestFixture({
        url: "https://first.example/start",
        options: {
          redirect: "follow",
          cookieMode: "omit",
          timeoutMs: 5_000,
          proxy: null,
          tls: {
            verify: true,
            caFile: file("ca"),
            clientCertificate: {
              certificate: file("certificate"),
              privateKey: file("private-key"),
            },
          },
        },
      }),
      302,
      "https://second.example/final",
    );
    expect(redirected?.options.tls.caFile).toMatchObject({ id: "ca" });
    expect(redirected?.options.tls.clientCertificate).toBeUndefined();
  });
});
