import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { availablePort } from "./chromium.mjs";
import { invariant } from "./utils.mjs";

/** Exact clean source probe only; this is not packaged artifact acceptance. */
export async function startReviewNode(root, extensionOrigin) {
  invariant(
    process.versions.node === "24.20.0",
    "Run the Node source probe with Node 24.20.0.",
  );
  const load = (path) => import(pathToFileURL(join(root, path)));
  const { startOneFetchNode } = await load("adapters/node/dist/server.js");
  const { testConfig } = await load("adapters/node/dist/test-helpers.js");
  const { OneFetchControlClient } = await load("packages/client/dist/index.js");
  const { handleConformanceTarget } = await load(
    "packages/conformance/dist/index.js",
  );
  const directory = await mkdtemp(join(tmpdir(), "one-fetch-browser-node-"));
  let server;
  const target = createServer((request, response) => {
    const handle = async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const upstream = await handleConformanceTarget(
        new globalThis.Request(`http://127.0.0.1${request.url}`, {
          method: request.method,
          headers: request.headers,
          ...(["GET", "HEAD"].includes(request.method)
            ? {}
            : { body: Buffer.concat(chunks) }),
        }),
      );
      response.writeHead(upstream.status, {
        ...Object.fromEntries(upstream.headers),
        "set-cookie": upstream.headers.getSetCookie(),
      });
      for await (const chunk of upstream.body ?? []) response.write(chunk);
      response.end();
    };
    void handle().catch(() => response.destroy());
  });
  const cleanup = async () => {
    target.closeAllConnections();
    if (target.listening) await new Promise((resolve) => target.close(resolve));
    await server?.close();
    invariant(
      dirname(directory) === tmpdir() &&
        basename(directory).startsWith("one-fetch-browser-node-"),
      "Unsafe fixture path.",
    );
    await rm(directory, { recursive: true });
  };
  try {
    await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetOrigin = `http://127.0.0.1:${target.address().port}`;
    const config = testConfig(join(directory, "test.sqlite"));
    config.controlPort = await availablePort();
    config.gatewayPort = await availablePort();
    config.publicControlUrl = `http://127.0.0.1:${config.controlPort}`;
    config.publicGatewayUrl = `http://127.0.0.1:${config.gatewayPort}`;
    config.controlAllowedOrigins = [extensionOrigin];
    server = await startOneFetchNode(config);
    const control = new OneFetchControlClient({
      controlUrl: config.publicControlUrl,
    });
    await control.bootstrap({
      schemaVersion: 1,
      bootstrapSecret: server.bootstrapToken,
      username: "synthetic",
      password: randomBytes(32).toString("hex"),
    });
    const state = await control.getConfiguration();
    await control.updatePolicy(
      {
        schemaVersion: 1,
        policy: {
          schemaVersion: 1,
          mode: "allowlist",
          revision: state.policy.revision,
          rules: [
            {
              id: "fixture",
              name: "Synthetic only",
              enabled: true,
              action: "allow",
              match: { origins: [{ operator: "exact", value: targetOrigin }] },
            },
          ],
        },
      },
      state.version,
    );
    const issued = await control.createExecutionToken({
      schemaVersion: 1,
      name: "browser-probe",
      scope: { transports: ["http"], origins: [targetOrigin], ports: [] },
      quota: {
        requestsPerMinute: 300,
        burst: 50,
        concurrentHttp: 4,
        concurrentTunnels: 0,
        bytesPerDay: 1_073_741_824,
      },
    });
    return {
      remoteControlUrl: config.publicControlUrl,
      remoteGatewayUrl: config.publicGatewayUrl,
      remoteToken: issued.token,
      remoteTargetUrl: targetOrigin,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
