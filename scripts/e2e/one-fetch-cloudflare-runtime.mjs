// Explicit opt-in only. Reuse the immutable one-fetch deployment tools; never
// modify an existing deployment or retain a public Gateway after acceptance.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { invariant } from "./utils.mjs";

const execute = promisify(execFile);
const sourceCommit = "b8e8b3558bca6236e92b7c18db167759da9cc43c";
const { OneFetchControlClient } = await import(
  new URL(
    "../../apps/extension/node_modules/@one-fetch/client/dist/index.js",
    import.meta.url,
  )
);

export async function startOneFetchCloudflareFixture(
  workspaceRoot,
  extensionOrigin,
) {
  const root = resolve(
    process.env.ONE_FETCH_SOURCE ?? join(workspaceRoot, "..", "one-fetch"),
  );
  const git = async (args) =>
    (
      await execute("git", args, { cwd: root, windowsHide: true })
    ).stdout.trim();
  invariant(
    (await git(["rev-parse", "HEAD"])) === sourceCommit &&
      (await git(["rev-parse", "v0.1.1^{commit}"])) === sourceCommit,
    "Cloudflare acceptance requires the reviewed one-fetch v0.1.1 checkout.",
  );
  invariant(
    !(await git(["status", "--porcelain", "--untracked-files=no"])),
    "Refusing to deploy a modified one-fetch checkout.",
  );
  const load = (path) => import(pathToFileURL(join(root, path)));
  const deploy = await load("tools/deploy/cloudflare.mjs");
  const fixtureTools = await load("tools/acceptance/cloudflare-fixture.mjs");
  const { generateCloudflareSecrets } = await load(
    "tools/deploy/generate-cloudflare-secrets.mjs",
  );
  const suffix = randomBytes(6).toString("hex");
  const deploymentId = `xp3-${suffix}`;
  const fixtureName = `one-fetch-fixture-${suffix}`;
  const privateDirectory = await mkdtemp(
    join(tmpdir(), "xpanel-one-fetch-cloudflare-"),
  );
  if (process.platform === "win32") {
    const user = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
    await execute(
      "icacls",
      [privateDirectory, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`],
      { windowsHide: true },
    );
  }
  let fixture;
  let control;
  let credential;
  let cleanupDone = false;
  const values = new Map([
    ["--deployment-id", deploymentId],
    ["--build-id", "0.1.1"],
    ["--expected-build", "none"],
    ["--secrets-file", join(privateDirectory, "secrets.json")],
    ["--xpanel-origins", extensionOrigin],
    ["--admin-origins", extensionOrigin],
  ]);
  const receipt = {
    schemaVersion: 1,
    adapter: "cloudflare",
    sourceCommit,
    deploymentId,
    fixtureName,
    createdAt: new Date().toISOString(),
    cleanupVerified: false,
  };
  const output = join(workspaceRoot, "artifacts", "one-fetch-e2e");
  const record = async () => {
    await mkdir(output, { recursive: true });
    await writeFile(
      join(output, `${deploymentId}.json`),
      JSON.stringify(receipt, null, 2),
    );
  };
  await record();
  const cleanup = async () => {
    if (cleanupDone) return;
    if (credential && control) {
      // Best effort; deleting the owned deployment below is authoritative.
      try {
        await control.revokeExecutionToken(credential.record.id);
      } catch {
        /* delete below */
      }
    }
    const state = join(
      root,
      ".tools",
      "cloudflare",
      deploymentId,
      "state.json",
    );
    const created = await access(state).then(
      () => true,
      () => false,
    );
    if (created)
      await deploy.cleanupCloudflareDeployment(
        new Map([
          ["--deployment-id", deploymentId],
          ["--confirm-id", deploymentId],
        ]),
      );
    if (fixture)
      await fixtureTools.cleanupCloudflareFixture(fixtureName, fixtureName);
    invariant(
      dirname(resolve(privateDirectory)) === resolve(tmpdir()) &&
        basename(privateDirectory).startsWith("xpanel-one-fetch-cloudflare-"),
      "Refusing unexpected temporary credential directory cleanup.",
    );
    await rm(privateDirectory, { recursive: true });
    receipt.cleanupVerified = true;
    receipt.cleanedAt = new Date().toISOString();
    await record();
    cleanupDone = true;
    process.stdout.write(
      `Cloudflare temporary Workers/D1 removed and absence verified (${deploymentId}).\n`,
    );
  };
  try {
    const plan = await deploy.createCloudflareDeploymentPlan(values);
    receipt.accountId = plan.accountId;
    await record();
    process.stdout.write(
      `Cloudflare temporary deployment plan verified (${deploymentId}).\n`,
    );
    const { secrets } = await generateCloudflareSecrets(
      values.get("--secrets-file"),
    );
    fixture = await fixtureTools.deployCloudflareFixture(fixtureName);
    const deployed = await deploy.applyCloudflareDeployment(values);
    receipt.controlUrl = deployed.controlUrl;
    receipt.gatewayUrl = deployed.gatewayUrl;
    receipt.targetOrigin = fixture.origin;
    await record();
    await deploy.verifyCloudflareDeployment(
      new Map([
        ["--deployment-id", deploymentId],
        ["--expected-build", "0.1.1"],
      ]),
    );
    control = new OneFetchControlClient({ controlUrl: deployed.controlUrl });
    await control.bootstrap({
      schemaVersion: 1,
      bootstrapSecret: secrets.BOOTSTRAP_SECRET,
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
    credential = await control.createExecutionToken({
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
    process.stdout.write(
      "Cloudflare one-fetch 0.1.1 ready with a synthetic-only policy and short-lived token.\n",
    );
    return {
      remoteControlUrl: deployed.controlUrl,
      remoteGatewayUrl: deployed.gatewayUrl,
      remoteToken: credential.token,
      remoteTargetUrl: `${fixture.origin}/v1/echo?duplicate=one&duplicate=two`,
      remoteExpectedMarker: "duplicate",
      remoteFixtureKind: "one-fetch-conformance",
      cleanup,
    };
  } catch (error) {
    receipt.failed = true;
    await record();
    await cleanup();
    // Avoid exposing a Control response or process environment in a tool log.
    throw new Error(
      `Cloudflare fixture failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}
