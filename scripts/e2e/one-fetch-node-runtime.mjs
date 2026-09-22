import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { availablePort } from "./chromium.mjs";
import { copyContainerInput } from "./container-input.mjs";
import { invariant, waitFor } from "./utils.mjs";

const { OneFetchControlClient } = await import(
  new URL(
    "../../apps/extension/node_modules/@one-fetch/client/dist/index.js",
    import.meta.url,
  )
);
const execute = promisify(execFile);
const image =
  "node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e";
const archiveHash =
  "d02189d7e22d433056f6e9d7e7c4cf81280617e301a9f81bc0bb9ee767bfc56b";
const archiveUrl =
  "https://github.com/OKFred/one-fetch/releases/download/v0.1.2/one-fetch-node-0.1.2.tar.gz";
const ownerLabel = "xpanel.one-fetch-e2e";
async function docker(args) {
  try {
    const result = await execute("docker", args, {
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    return result.stdout.trim();
  } catch {
    throw new Error(
      `Disposable one-fetch Docker ${args[0]} failed (output suppressed).`,
    );
  }
}

export async function startOneFetchNodeFixture(workspaceRoot) {
  const directory = resolve(workspaceRoot, "artifacts", "one-fetch-e2e");
  await mkdir(directory, { recursive: true });
  const archive = resolve(directory, "one-fetch-node-0.1.2.tar.gz");
  let bytes;
  try {
    bytes = await readFile(archive);
  } catch {
    const response = await fetch(archiveUrl, {
      signal: globalThis.AbortSignal.timeout(60_000),
    });
    invariant(
      response.ok,
      "Could not download published one-fetch Node archive.",
    );
    bytes = Buffer.from(await response.arrayBuffer());
  }
  invariant(
    createHash("sha256").update(bytes).digest("hex") === archiveHash,
    "Node Release archive digest mismatch.",
  );
  await writeFile(archive, bytes);
  const owner = randomUUID();
  const name = `xpanel-one-fetch-${randomBytes(6).toString("hex")}`;
  const controlUrl = `http://127.0.0.1:${await availablePort()}`;
  const gatewayUrl = `http://127.0.0.1:${await availablePort()}`;
  let id;
  const cleanup = async () => {
    if (!id) return;
    const labels = JSON.parse(
      await docker(["inspect", "--format", "{{json .Config.Labels}}", id]),
    );
    invariant(
      labels[ownerLabel] === owner,
      "Refusing cleanup: container owner mismatch.",
    );
    await docker(["rm", "--force", "--volumes", id]);
    invariant(
      !(await docker([
        "ps",
        "--all",
        "--filter",
        `id=${id}`,
        "--format",
        "{{.ID}}",
      ])),
      "Container cleanup was not confirmed.",
    );
    process.stdout.write(
      "one-fetch Node fixture removed; container absence confirmed.\n",
    );
  };
  try {
    id = await docker([
      "create",
      "--name",
      name,
      "--label",
      `${ownerLabel}=${owner}`,
      "--pull",
      "never",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--log-driver",
      "none",
      "--user",
      "1000:1000",
      "--memory",
      "512m",
      "--pids-limit",
      "128",
      "--tmpfs",
      "/tmp:rw,uid=1000,gid=1000,mode=0700,size=128m",
      "--publish",
      `${new URL(controlUrl).host}:8787`,
      "--publish",
      `${new URL(gatewayUrl).host}:8788`,
      "--env",
      `ONE_FETCH_PUBLIC_CONTROL_URL=${controlUrl}`,
      "--env",
      `ONE_FETCH_PUBLIC_GATEWAY_URL=${gatewayUrl}`,
      "--env",
      `ONE_FETCH_INSTANCE_ID=${name}`,
      image,
      "node",
      "-e",
      "const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync('/tmp/entry.mjs')){clearInterval(timer);import('/tmp/entry.mjs').catch(()=>{process.exitCode=1})}},50);",
    ]);
    invariant(/^[a-f0-9]{64}$/u.test(id), "Unexpected container identity.");
    await docker(["start", id]);
    await copyContainerInput(id, archive, "/tmp/one-fetch.tar.gz");
    await copyContainerInput(
      id,
      resolve(import.meta.dirname, "one-fetch-node-entry.mjs"),
      "/tmp/entry.mjs",
    );
    await waitFor(
      async () => {
        try {
          return (
            await fetch(`${controlUrl}/api/v1/health`, {
              signal: globalThis.AbortSignal.timeout(1000),
            })
          ).ok;
        } catch {
          return false;
        }
      },
      "one-fetch Node startup",
      30_000,
    );
    const bootstrapSecret = await docker([
      "exec",
      id,
      "node",
      "-e",
      "process.stdout.write(require('node:fs').readFileSync('/tmp/state/bootstrap'))",
    ]);
    const control = new OneFetchControlClient({ controlUrl });
    await control.bootstrap({
      schemaVersion: 1,
      bootstrapSecret,
      username: "xpanel-synthetic",
      password: randomBytes(36).toString("base64url"),
    });
    let config = await control.getConfiguration();
    const origin = "http://127.0.0.1:9090";
    config = await control.updatePolicy(
      {
        schemaVersion: 1,
        policy: {
          schemaVersion: 1,
          mode: "allowlist",
          revision: config.policy.revision,
          rules: [
            {
              id: "synthetic",
              name: "Synthetic only",
              action: "allow",
              enabled: true,
              match: {
                transports: ["http"],
                schemes: ["http"],
                origins: [
                  { operator: "exact", value: origin, caseSensitive: false },
                ],
              },
            },
          ],
        },
      },
      config.version,
    );
    if (config.gatewayPaused)
      await control.setGatewayPaused(
        { schemaVersion: 1, paused: false },
        config.version,
      );
    const credential = await control.createExecutionToken({
      schemaVersion: 1,
      name: "xpanel-e2e",
      scope: { transports: ["http"], origins: [origin], ports: [9090] },
      quota: {
        requestsPerMinute: 300,
        burst: 50,
        concurrentHttp: 4,
        concurrentTunnels: 0,
        bytesPerDay: 1073741824,
      },
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    process.stdout.write(
      "one-fetch Node 24.20.0 fixture ready from verified v0.1.2 archive (loopback only).\n",
    );
    return {
      remoteFixtureKind: "xpanel-synthetic-v1",
      remoteControlUrl: controlUrl,
      remoteGatewayUrl: gatewayUrl,
      remoteToken: credential.token,
      remoteTargetUrl: `${origin}/v1/echo?duplicate=one&duplicate=two`,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
