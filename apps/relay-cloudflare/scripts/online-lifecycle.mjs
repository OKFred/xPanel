import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import {
  activeVersionId,
  createFixtureName,
  parseLifecycleEnvironment,
  relayBindingState,
  runOnlineLifecycle,
} from "./online-lifecycle-lib.mjs";

const packageRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(packageRoot, "../..");
const fixtureConfig = resolve(packageRoot, "test/fixtures/wrangler.jsonc");
const relayConfig = resolve(packageRoot, "wrangler.jsonc");
const protocolScript = resolve(import.meta.dirname, "online-acceptance.mjs");
const chromiumScript = resolve(repositoryRoot, "scripts/e2e-chromium.mjs");
const wranglerCli = createRequire(import.meta.url).resolve("wrangler");
const maximumCapturedBytes = 4 * 1024 * 1024;
let activeChild;
let interruptedSignal;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (interruptedSignal) {
      process.stderr.write(
        `Cleanup is already running after ${interruptedSignal}; ignoring ${signal}.\n`,
      );
      return;
    }
    interruptedSignal = signal;
    process.stderr.write(
      `${signal} received; stopping the active check and starting cleanup.\n`,
    );
    activeChild?.kill(signal);
  });
}

function appendCaptured(current, chunk) {
  const next = `${current}${String(chunk)}`;
  if (Buffer.byteLength(next, "utf8") > maximumCapturedBytes) {
    throw new Error("A child process exceeded the lifecycle output limit.");
  }
  return next;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const capture = options.capture === true;
    const child = spawn(command, args, {
      cwd: options.cwd ?? packageRoot,
      env: options.env ?? process.env,
      shell: false,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      windowsHide: true,
    });
    activeChild = child;
    let stdout = "";
    let stderr = "";
    let outputError;
    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        try {
          stdout = appendCaptured(stdout, chunk);
        } catch (error) {
          outputError = error;
          child.kill();
        }
      });
      child.stderr.on("data", (chunk) => {
        try {
          stderr = appendCaptured(stderr, chunk);
        } catch (error) {
          outputError = error;
          child.kill();
        }
      });
    }
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (activeChild === child) activeChild = undefined;
      if (outputError) {
        rejectRun(outputError);
        return;
      }
      const result = { code, signal, stdout, stderr };
      if (code === 0 || options.allowFailure === true) {
        resolveRun(result);
        return;
      }
      rejectRun(
        new Error(
          `${options.label ?? command} failed with ${signal ?? `exit ${code}`}.${capture && stderr.trim() ? ` ${stderr.trim()}` : ""}`,
        ),
      );
    });
  });
}

function runWrangler(args, options = {}) {
  return runProcess(process.execPath, [wranglerCli, ...args], {
    ...options,
    label: options.label ?? `wrangler ${args[0] ?? "command"}`,
  });
}

async function wranglerJson(args) {
  const result = await runWrangler([...args, "--json"], { capture: true });
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Wrangler returned invalid JSON for ${args[0]}.`);
  }
}

async function inspectRelay(relayName) {
  const status = await wranglerJson([
    "deployments",
    "status",
    "--name",
    relayName,
  ]);
  const versionId = activeVersionId(status);
  const version = await wranglerJson([
    "versions",
    "view",
    versionId,
    "--name",
    relayName,
  ]);
  return { versionId, ...relayBindingState(version) };
}

function relayDeployArguments(config, allowedOrigins, selfOrigins, message) {
  return [
    "deploy",
    "--config",
    relayConfig,
    "--name",
    config.relayName,
    "--strict",
    "--message",
    message,
    "--var",
    "TARGET_POLICY:allowlist",
    "--var",
    `ALLOWED_TARGET_ORIGINS:${allowedOrigins}`,
    "--var",
    `RELAY_SELF_ORIGINS:${selfOrigins}`,
  ];
}

async function assertRelayState(config, expectedAllowed, expectedSelf) {
  const state = await inspectRelay(config.relayName);
  if (
    state.policy !== "allowlist" ||
    state.allowedOrigins !== expectedAllowed ||
    state.selfOrigins !== expectedSelf
  ) {
    throw new Error(
      "The active Relay bindings do not match the requested state.",
    );
  }
  return state;
}

async function waitForHttp(url, predicate, label, options = {}) {
  let lastStatus;
  let lastError;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    if (interruptedSignal && options.ignoreInterrupt !== true) {
      throw new Error(`Interrupted by ${interruptedSignal}.`);
    }
    try {
      const response = await fetch(url, {
        redirect: "error",
        signal: globalThis.AbortSignal.timeout(5_000),
      });
      lastStatus = response.status;
      if (await predicate(response)) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error(
    `${label} did not become ready; last status ${lastStatus ?? "unavailable"}.${lastError instanceof Error ? ` ${lastError.message}` : ""}`,
  );
}

function childEnvironment(config, targetUrl) {
  return {
    ...process.env,
    XPANEL_REMOTE_BASE_URL: config.relayBaseUrl,
    XPANEL_REMOTE_TARGET_URL: targetUrl,
    XPANEL_REMOTE_TOKEN: config.relayToken,
    ...(config.chromiumExecutable
      ? { XPANEL_CHROMIUM_EXECUTABLE: config.chromiumExecutable }
      : {}),
  };
}

async function preflightRelay(config) {
  const response = await fetch(`${config.relayBaseUrl}/v1/capabilities`, {
    headers: { Authorization: `Bearer ${config.relayToken}` },
    signal: globalThis.AbortSignal.timeout(10_000),
  });
  if (response.status !== 200) {
    throw new Error(
      `Relay authentication preflight returned HTTP ${response.status}; verify XPANEL_REMOTE_TOKEN.`,
    );
  }
  let capabilities;
  try {
    capabilities = await response.json();
  } catch {
    throw new Error("Relay authentication preflight returned invalid JSON.");
  }
  if (
    capabilities?.protocolVersion !== 1 ||
    capabilities?.provider !== "cloudflare"
  ) {
    throw new Error(
      "Relay authentication preflight returned unsupported capabilities.",
    );
  }
}

async function ensureCleanRepository() {
  const result = await runProcess(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=normal"],
    { capture: true, cwd: repositoryRoot, label: "git status" },
  );
  if (result.stdout.trim() !== "") {
    throw new Error(
      "Commit or stash workspace changes before online lifecycle acceptance.",
    );
  }
}

function isMissingWorker(result) {
  return /(?:not found|has no deployments|10007|10090)/iu.test(
    `${result.stdout}\n${result.stderr}`,
  );
}

async function main() {
  const environment = parseLifecycleEnvironment(process.env);
  await ensureCleanRepository();
  const fixtureName = createFixtureName(randomBytes(6));
  const runId = fixtureName.slice(-12);
  const fixtureOrigin = `https://${fixtureName}.${environment.workersDevSuffix}`;
  const config = { ...environment, fixtureName, fixtureOrigin, runId };

  process.stdout.write(`Online lifecycle Fixture: ${fixtureName}\n`);
  await runOnlineLifecycle(config, {
    inspectRelay: () => inspectRelay(config.relayName),
    preflightRelay: () => preflightRelay(config),
    async deployFixture() {
      await runWrangler([
        "deploy",
        "--config",
        fixtureConfig,
        "--name",
        fixtureName,
        "--message",
        `xPanel online acceptance ${runId}`,
      ]);
    },
    async waitForFixture() {
      await waitForHttp(
        `${fixtureOrigin}/e2e`,
        async (response) =>
          response.status === 200 &&
          (await response.text()).includes("remote-e2e-ok"),
        "Fixture Worker",
      );
    },
    async openRelay(_config, baseline) {
      await runWrangler(
        relayDeployArguments(
          config,
          fixtureOrigin,
          baseline.selfOrigins,
          `temporary online allowlist ${runId}`,
        ),
      );
      const state = await assertRelayState(
        config,
        fixtureOrigin,
        baseline.selfOrigins,
      );
      process.stdout.write(`Temporary Relay version: ${state.versionId}\n`);
    },
    async runProtocolAcceptance() {
      await runProcess(process.execPath, [protocolScript], {
        env: childEnvironment(config, fixtureOrigin),
        label: "Relay protocol acceptance",
      });
    },
    async runChromiumAcceptance() {
      await runProcess(process.execPath, [chromiumScript], {
        cwd: repositoryRoot,
        env: childEnvironment(config, `${fixtureOrigin}/e2e`),
        label: "Chromium Remote acceptance",
      });
    },
    async restoreRelay(_config, baseline) {
      await runWrangler(
        relayDeployArguments(
          config,
          "",
          baseline.selfOrigins,
          `restore empty allowlist after ${runId}`,
        ),
      );
      const state = await assertRelayState(config, "", baseline.selfOrigins);
      process.stdout.write(`Restored Relay version: ${state.versionId}\n`);
    },
    async deleteFixture() {
      const deletion = await runWrangler(
        ["delete", "--config", fixtureConfig, "--name", fixtureName, "--force"],
        { allowFailure: true, capture: true },
      );
      if (deletion.code !== 0 && !isMissingWorker(deletion)) {
        throw new Error("Wrangler could not delete the Fixture Worker.");
      }
      await waitForHttp(
        `${fixtureOrigin}/e2e`,
        (response) => Promise.resolve(response.status === 404),
        "Fixture deletion",
        { ignoreInterrupt: true },
      );
      const status = await runWrangler(
        ["deployments", "status", "--name", fixtureName, "--json"],
        { allowFailure: true, capture: true },
      );
      if (status.code === 0 || !isMissingWorker(status)) {
        throw new Error(
          "Fixture deletion could not be confirmed through Wrangler.",
        );
      }
      process.stdout.write(`Deleted Fixture: ${fixtureName}\n`);
    },
  });

  if (interruptedSignal)
    throw new Error(`Interrupted by ${interruptedSignal}.`);
  process.stdout.write(
    "Online lifecycle acceptance passed; Relay closed and Fixture deleted.\n",
  );
}

main().catch((error) => {
  if (error instanceof AggregateError) {
    process.stderr.write(`${error.message}\n`);
    for (const cause of error.errors) {
      process.stderr.write(
        `- ${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
    }
  } else {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  process.exitCode = interruptedSignal ? 130 : 1;
});
