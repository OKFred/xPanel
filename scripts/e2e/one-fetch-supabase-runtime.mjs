import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { invariant } from "./utils.mjs";
import { deploymentDiagnostic } from "./deployment-diagnostic.mjs";
import { verifyOneFetchSource } from "./one-fetch-source.mjs";

const execute = promisify(execFile);
const { OneFetchControlClient } = await import(
  new URL(
    "../../apps/extension/node_modules/@one-fetch/client/dist/index.js",
    import.meta.url,
  )
);

export async function startOneFetchSupabaseFixture(
  workspaceRoot,
  extensionOrigin,
  review,
) {
  invariant(
    process.platform === "win32",
    "This online acceptance helper uses the logged-in Windows Supabase credential store.",
  );
  const root = resolve(
    process.env.ONE_FETCH_SOURCE ?? join(workspaceRoot, "..", "one-fetch"),
  );
  const source = await verifyOneFetchSource(root, review);
  const commit = source.commit;
  const load = (path) => import(pathToFileURL(join(root, path)));
  const { buildId } = await load(
    "adapters/supabase/scripts/deploy-support.mjs",
  );
  const expectedBuildVersion = buildId(source.version, source.commit);
  const fixtureTools = await load("tools/acceptance/cloudflare-fixture.mjs");
  const cf = await load("tools/deploy/cloudflare-runtime.mjs");
  const suffix = randomBytes(6).toString("hex");
  const name = `xpanel-three-${suffix}`;
  const fixtureName = `one-fetch-fixture-${suffix}`;
  const directory = await mkdtemp(join(tmpdir(), "xpanel-one-fetch-supabase-"));
  await execute(
    "icacls",
    [
      directory,
      "/inheritance:r",
      "/grant:r",
      `${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)F`,
    ],
    { windowsHide: true },
  );
  const platform = async (action) => {
    try {
      const output = await execute(
        "pwsh",
        [
          "-NoProfile",
          "-File",
          join(import.meta.dirname, "supabase-platform.ps1"),
          "-Action",
          action,
          "-StateDirectory",
          directory,
          "-ProjectName",
          name,
        ],
        { windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 },
      );
      return JSON.parse(output.stdout);
    } catch (error) {
      receipt.installDiagnostic = await deploymentDiagnostic(error, directory);
      await record();
      process.stderr.write(
        `Supabase sanitized install diagnostic:\n${receipt.installDiagnostic}\n`,
      );
      throw new Error(
        `Supabase platform ${action} failed; inspect the exact ownership journal (output suppressed).`,
      );
    }
  };
  const receipt = {
    schemaVersion: 1,
    adapter: "supabase",
    commit,
    sourceKind: source.sourceKind,
    buildVersion: expectedBuildVersion,
    name,
    fixtureName,
    createdAt: new Date().toISOString(),
    cleanupVerified: false,
  };
  const outputRoot = join(workspaceRoot, "artifacts", "one-fetch-e2e");
  const record = async () => {
    await mkdir(outputRoot, { recursive: true });
    await writeFile(
      join(outputRoot, `${name}.json`),
      JSON.stringify(receipt, null, 2),
    );
  };
  let fixtureAttempted = false;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    const state = await readFile(join(directory, "platform.json"), "utf8").then(
      JSON.parse,
      () => undefined,
    );
    if (state?.createRequestedAt && !state.projectRef)
      throw new Error(
        `Supabase creation is uncertain; retain the ownership journal at ${directory}.`,
      );
    if (state?.projectRef) {
      const deleted = await platform("delete");
      invariant(deleted.absent, "Supabase cleanup is not verified.");
    }
    if (fixtureAttempted && (await cf.workerExists(fixtureName)))
      await fixtureTools.cleanupCloudflareFixture(fixtureName, fixtureName);
    invariant(
      !(await cf.workerExists(fixtureName)),
      "Synthetic Worker still exists.",
    );
    invariant(
      dirname(resolve(directory)) === resolve(tmpdir()) &&
        basename(directory).startsWith("xpanel-one-fetch-supabase-"),
      "Refusing unexpected credential directory deletion.",
    );
    await rm(directory, { recursive: true });
    receipt.cleanupVerified = true;
    receipt.cleanedAt = new Date().toISOString();
    await record();
    cleaned = true;
    process.stdout.write(
      `Supabase temporary project and synthetic Worker removed; absence verified (${name}).\n`,
    );
  };
  try {
    await record();
    const created = await platform("create");
    receipt.projectRef = created.projectRef;
    await record();
    process.stdout.write(
      `Supabase temporary Free project created (${name}); waiting for readiness.\n`,
    );
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if ((await platform("ready")).status === "ACTIVE_HEALTHY") {
        ready = true;
        break;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
    }
    invariant(ready, "Supabase temporary project did not become healthy.");
    await platform("key");
    const adapter = join(root, "adapters", "supabase");
    const envFile = join(directory, "deployment.env");
    await execute(
      process.execPath,
      [
        join(adapter, "scripts", "generate-env.mjs"),
        "--out",
        envFile,
        "--project-ref",
        created.projectRef,
        "--extension-id",
        new URL(extensionOrigin).host,
      ],
      { windowsHide: true },
    );
    process.stdout.write(
      `Supabase v${source.version} guarded install running (empty-schema check and deployment CAS).\n`,
    );
    try {
      await execute(
        process.execPath,
        [
          join(adapter, "scripts", "deploy-release.mjs"),
          "--project-ref",
          created.projectRef,
          "--env-file",
          envFile,
          "--expected-current-build",
          "none",
          "--state-file",
          join(directory, "deployment.json"),
          "--service-role-key-file",
          join(directory, "service-role-key"),
          "--db-password-file",
          join(directory, "database-password"),
          "--apply",
        ],
        {
          cwd: adapter,
          windowsHide: true,
          timeout: 600_000,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
    } catch (error) {
      receipt.installDiagnostic = await deploymentDiagnostic(error, directory);
      await record();
      process.stderr.write(
        `Supabase sanitized install diagnostic:\n${receipt.installDiagnostic}\n`,
      );
      throw new Error(
        "Supabase guarded install failed; see the sanitized diagnostic.",
      );
    }
    invariant(
      !(await cf.workerExists(fixtureName)),
      "Synthetic Worker name already exists.",
    );
    fixtureAttempted = true;
    const fixture = await fixtureTools.deployCloudflareFixture(fixtureName, {
      // Same bounded workers.dev propagation window as Cloudflare acceptance.
      wait: () => new Promise((resolveWait) => setTimeout(resolveWait, 5_000)),
      // Readiness GETs are safe to retry; resource creation is never retried.
      fetch: async (url, init) => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            return await fetch(url, init);
          } catch (error) {
            if (attempt === 2) throw error;
          }
        }
      },
    });
    const environment = new Map(
      (await readFile(envFile, "utf8"))
        .trim()
        .split(/\r?\n/u)
        .map((line) => {
          const i = line.indexOf("=");
          return [line.slice(0, i), line.slice(i + 1)];
        }),
    );
    const controlUrl = environment.get("ONE_FETCH_CONTROL_BASE_URL");
    const gatewayUrl = environment.get("ONE_FETCH_GATEWAY_BASE_URL");
    const control = new OneFetchControlClient({ controlUrl });
    invariant(
      (await control.getCapabilities()).buildVersion === expectedBuildVersion,
      "Supabase build identity does not match the reviewed commit.",
    );
    await control.bootstrap({
      schemaVersion: 1,
      bootstrapSecret: environment.get("ONE_FETCH_BOOTSTRAP_SECRET"),
      username: "xpanel-synthetic",
      password: randomBytes(36).toString("base64url"),
    });
    let config = await control.getConfiguration();
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
                origins: [
                  {
                    operator: "exact",
                    value: fixture.origin,
                    caseSensitive: false,
                  },
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
      name: "xpanel-chromium-only",
      scope: { transports: ["http"], origins: [fixture.origin], ports: [443] },
      quota: {
        requestsPerMinute: 300,
        burst: 50,
        concurrentHttp: 4,
        concurrentTunnels: 0,
        bytesPerDay: 1073741824,
      },
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    receipt.controlUrl = controlUrl;
    receipt.gatewayUrl = gatewayUrl;
    receipt.targetOrigin = fixture.origin;
    await record();
    process.stdout.write(
      "Supabase one-fetch ready: same origin, separate Function prefixes, synthetic-only target policy.\n",
    );
    return {
      remoteControlUrl: controlUrl,
      remoteBuildVersion: expectedBuildVersion,
      remoteGatewayUrl: gatewayUrl,
      remoteToken: credential.token,
      remoteTargetUrl: `${fixture.origin}/v1/echo?duplicate=one&duplicate=two`,
      remoteExpectedMarker: "duplicate",
      remoteFixtureKind: "one-fetch-conformance",
      recordAcceptance: async (passed) => {
        receipt.acceptancePassed = passed;
        receipt.acceptanceFinishedAt = new Date().toISOString();
        await record();
      },
      cleanup,
    };
  } catch (error) {
    receipt.failed = true;
    await record();
    await cleanup();
    throw error;
  }
}
