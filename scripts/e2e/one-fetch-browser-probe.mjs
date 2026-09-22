import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { CdpClient, jsonEndpoint, openPageTarget } from "./cdp-client.mjs";
import { findChromium, availablePort } from "./chromium.mjs";
import { grantTestHostAccess } from "./extension-permissions.mjs";
import { startOneFetchCloudflareFixture } from "./one-fetch-cloudflare-runtime.mjs";
import { startOneFetchSupabaseFixture } from "./one-fetch-supabase-runtime.mjs";
import { startReviewNode } from "./one-fetch-review-node.mjs";
import { verifyOneFetchSource } from "./one-fetch-source.mjs";
import { invariant, waitFor } from "./utils.mjs";

const [adapter, commit] = process.argv.slice(2);
invariant(
  ["node", "cloudflare", "supabase"].includes(adapter),
  "Choose node, cloudflare or supabase.",
);
const workspace = resolve(import.meta.dirname, "../..");
const root = resolve(
  process.env.ONE_FETCH_SOURCE ?? join(workspace, "..", "one-fetch"),
);
const source = await verifyOneFetchSource(root, { commit });
const extensionRoot = join(workspace, "apps/extension/.output/chrome-mv3");
const { build } = await import(
  pathToFileURL(join(root, "node_modules/esbuild/lib/main.js"))
);
const bundle = await build({
  stdin: {
    contents:
      'import { z } from "./packages/protocol/node_modules/zod/index.js"; z.config({ jitless: true }); export * from "./packages/client/dist/index.js";',
    resolveDir: root,
  },
  bundle: true,
  write: false,
  format: "iife",
  globalName: "OneFetchProbe",
  platform: "browser",
});
const cspBootstrap = await build({
  stdin: {
    contents:
      'import { z } from "./packages/protocol/node_modules/zod/index.js"; z.config({ jitless: true });',
    resolveDir: root,
  },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
});
const profile = await mkdtemp(join(tmpdir(), "one-fetch-browser-probe-"));
const port = await availablePort();
let processHandle, browser, page, runtime;
const receipt = {
  schemaVersion: 1,
  testKind: "official-client-chromium-source",
  adapter,
  ...source,
  startedAt: new Date().toISOString(),
  checks: [],
  passed: false,
  cleanupVerified: false,
};

try {
  processHandle = spawn(
    await findChromium(),
    [
      "--headless=new",
      "--no-first-run",
      "--disable-background-networking",
      "--disable-sync",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--load-extension=${extensionRoot}`,
      `--disable-extensions-except=${extensionRoot}`,
      "about:blank",
    ],
    { stdio: "ignore", windowsHide: true },
  );
  const version = await waitFor(
    () => jsonEndpoint(port, "/json/version"),
    "Browser probe startup",
  );
  receipt.browserVersion = version.Browser;
  browser = await new CdpClient(version.webSocketDebuggerUrl).open();
  const inventory = await openPageTarget(browser, port, "chrome://extensions");
  const installed = await inventory.client.evaluate(
    "(async () => (await chrome.developerPrivate.getExtensionsInfo({includeDisabled:false,includeTerminated:false})).map(x=>({id:x.id,name:x.name,path:x.path})))()",
  );
  const extension = installed.find(
    (item) => item.name === "xPanel" && resolve(item.path) === extensionRoot,
  );
  invariant(
    extension,
    "Loaded xPanel identity is missing from Chrome's extension inventory.",
  );
  inventory.client.close();
  await browser.send("Target.closeTarget", { targetId: inventory.target.id });
  const origin = `chrome-extension://${extension.id}`;
  page = await openPageTarget(browser, port, `${origin}/workbench.html`);
  await waitFor(
    () => page.client.evaluate("Boolean(chrome.runtime?.id)"),
    "Probe extension page",
  );
  const start =
    adapter === "node"
      ? () => startReviewNode(root, origin)
      : adapter === "cloudflare"
        ? () => startOneFetchCloudflareFixture(workspace, origin, { commit })
        : () => startOneFetchSupabaseFixture(workspace, origin, { commit });
  runtime = await start();
  receipt.serviceBuildVersion = runtime.remoteBuildVersion ?? source.version;
  await grantTestHostAccess(browser, port, extension.id, [
    runtime.remoteControlUrl,
    runtime.remoteGatewayUrl,
  ]);
  const granted = await page.client.evaluate(
    `Promise.race([chrome.permissions.request({ origins: ${JSON.stringify([...new Set([runtime.remoteControlUrl, runtime.remoteGatewayUrl].map((url) => `${new URL(url).origin}/*`))])} }), new Promise(resolve => setTimeout(() => resolve(false), 15000))])`,
    { userGesture: true },
  );
  invariant(granted, "Actual optional host permission was not granted.");
  // CDP evaluation can make Zod's one-time eval feature probe succeed even
  // though later page callbacks use MV3 CSP. Disable JIT before schemas exist.
  await page.client.evaluate(cspBootstrap.outputFiles[0].text);
  await page.client.evaluate(bundle.outputFiles[0].text);
  const input = {
    controlUrl: runtime.remoteControlUrl,
    gatewayUrl: runtime.remoteGatewayUrl,
    token: runtime.remoteToken,
    targetOrigin: new URL(runtime.remoteTargetUrl).origin,
    expectedVersion: runtime.remoteBuildVersion ?? source.version,
  };
  // Tokens stay in the disposable browser memory, never receipts, logs or screenshots.
  const results = await page.client.evaluate(
    `(${browserProbe.toString()})(${JSON.stringify(input)})`,
  );
  receipt.checks = results;
  receipt.passed = results.every((result) => result.passed);
  receipt.acceptancePassed = receipt.passed;
  await runtime.recordAcceptance?.(receipt.passed);
  invariant(
    receipt.passed,
    "Browser envelope candidate acceptance failed; see redacted case results.",
  );
} finally {
  page?.client.close();
  if (browser) {
    await browser.send("Browser.close").catch(() => undefined);
    browser.close();
  }
  if (processHandle && processHandle.exitCode === null)
    await new Promise((done) => {
      processHandle.once("exit", done);
      processHandle.kill();
    });
  let cleanupFailed = false;
  try {
    await runtime?.cleanup();
  } catch {
    cleanupFailed = true;
    receipt.cleanupFailure = "runtime-cleanup-failed";
  }
  try {
    invariant(
      dirname(profile) === tmpdir() &&
        basename(profile).startsWith("one-fetch-browser-probe-"),
      "Unexpected Chromium profile cleanup path.",
    );
    await rm(profile, { recursive: true });
  } catch {
    cleanupFailed = true;
    receipt.profileCleanupFailure = "profile-cleanup-failed";
  }
  receipt.cleanupVerified = runtime !== undefined && !cleanupFailed;
  receipt.passed = receipt.passed && receipt.cleanupVerified;
  receipt.finishedAt = new Date().toISOString();
  const directory = join(workspace, "artifacts/one-fetch-e2e");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(
      directory,
      `browser-${adapter}-${commit.slice(0, 12)}-${randomUUID()}.json`,
    ),
    JSON.stringify(receipt, null, 2),
    { flag: "wx" },
  );
  console.log(JSON.stringify(receipt));
  invariant(
    !cleanupFailed,
    "Probe cleanup incomplete; inspect the owned runtime receipt. No cleanup retry was attempted.",
  );
}

async function browserProbe(input) {
  const { OneFetchControlClient, OneFetchGatewayClient } =
    globalThis.OneFetchProbe;
  const serviceFetch = (url, init) =>
    fetch(url, {
      ...init,
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
  const control = new OneFetchControlClient({
    controlUrl: input.controlUrl,
    fetch: serviceFetch,
  });
  const capabilities = await control.getCapabilities();
  if (capabilities.buildVersion !== input.expectedVersion)
    throw new Error("Service build version differs from the reviewed source.");
  const client = new OneFetchGatewayClient({
    gatewayUrl: input.gatewayUrl,
    token: input.token,
    capabilities: capabilities.fetchOptions,
    fetch: serviceFetch,
    executionReports: { controlUrl: input.controlUrl, fetch: serviceFetch },
  });
  async function finalReport(metadata) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const report = await control.getExecutionReport(
          metadata.reportId,
          input.token,
          {
            signal: globalThis.AbortSignal.timeout(5000),
          },
        );
        if (
          report.requestId !== metadata.requestId ||
          report.reportId !== metadata.reportId
        )
          throw new Error("report-identity");
        return report;
      } catch {
        await new Promise((done) => setTimeout(done, 250));
      }
    }
  }
  const results = [];
  for (const path of [
    "/status/201",
    "/status/302",
    "/status/404",
    "/status/503",
    "/redirect",
    "/set-cookie",
    "/server-timing",
    "/bytes/20971520",
    "/bytes/20971521",
  ]) {
    const check = { case: path, passed: false };
    try {
      const result = await client.executeHttp({
        method: "GET",
        targetUrl: input.targetOrigin + path,
        fetchOptions: {
          redirect: "manual",
          timeoutMs: 60_000,
          adapter: {
            browserResponse: "envelope-v1",
            ...(capabilities.provider === "cloudflare"
              ? { cloudflareAcceptMutations: true }
              : capabilities.provider === "supabase"
                ? { supabaseAcceptMutations: true }
                : {}),
          },
        },
      });
      const classification = result.classification;
      check.source = classification.source;
      check.outerStatus = result.response.status;
      if (
        classification.source === "target" &&
        classification.target.kind === "http"
      )
        check.targetStatus = classification.target.status;
      if (classification.source === "relay")
        check.code = classification.error.code;
      if (path === "/bytes/20971521") {
        check.passed =
          classification.source === "relay" &&
          classification.error.code === "response_too_large" &&
          result.response.status === 200;
        if (classification.source === "target") {
          // A streaming vendor may strip Content-Length. Headers are already
          // committed then; require a bounded failed stream AND final report.
          let received = 0;
          let interrupted = false;
          const reader = result.response.body.getReader();
          try {
            while (true) {
              const item = await reader.read();
              if (item.done) break;
              received += item.value.byteLength;
              if (received > 20 * 1024 * 1024) {
                await reader.cancel();
                break;
              }
            }
          } catch {
            interrupted = true;
          } finally {
            reader.releaseLock();
          }
          const report = await finalReport(classification.metadata);
          check.passed =
            interrupted &&
            received <= 20 * 1024 * 1024 &&
            result.response.status === 200 &&
            classification.metadata.responseMode === "browser-envelope-v1" &&
            report?.outcome === "partial" &&
            !report.bodyComplete &&
            !report.bodySha256 &&
            report.problem?.code === "response_too_large";
          check.code = report
            ? (report.problem?.code ?? "report-cause-unavailable")
            : "missing-final-report";
          check.integrity = "not-verified";
          check.reportOutcome = report?.outcome ?? "unavailable";
          check.interrupted = interrupted;
          check.bytesReceived = received;
        } else await result.response.body?.cancel();
      } else {
        if (
          classification.source !== "target" ||
          classification.target.kind !== "http"
        )
          throw new Error("source");
        const status = path.startsWith("/status/")
          ? Number(path.slice(8))
          : path === "/redirect"
            ? 302
            : 200;
        if (
          result.response.status !== 200 ||
          classification.target.status !== status ||
          classification.metadata.responseMode !== "browser-envelope-v1"
        )
          throw new Error("status-binding");
        if (
          result.response.headers.has("location") ||
          result.response.headers.has("set-cookie")
        )
          throw new Error("outer-headers");
        if (
          path === "/set-cookie" &&
          classification.target.setCookie.length !== 2
        )
          throw new Error("cookies");
        if (
          path === "/server-timing" &&
          !classification.metadata.timing.serverTiming.some(
            (entry) => entry.name === "db",
          )
        )
          throw new Error("timing");
        const body = await result.response.arrayBuffer();
        const digest = [
          ...new Uint8Array(await crypto.subtle.digest("SHA-256", body)),
        ]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
        const report = await finalReport(classification.metadata);
        check.passed =
          report?.status === status &&
          report?.outcome === "completed" &&
          report?.bodyComplete &&
          report?.responseBytes === body.byteLength &&
          report?.bodySha256 === digest;
        check.integrity = check.passed ? "verified" : "not-verified";
      }
    } catch (error) {
      check.failure = "request-or-verification-failed";
      check.errorName =
        error instanceof TypeError
          ? "TypeError"
          : error?.name === "AbortError"
            ? "AbortError"
            : "Error";
      if (
        /^(source|status-binding|outer-headers|cookies|timing)$/u.test(
          error?.message ?? "",
        )
      )
        check.failure = error.message;
      if (
        error instanceof TypeError &&
        /Gateway does not support|capabilities/u.test(error.message)
      )
        check.failure = "capability-mismatch";
    }
    results.push(check);
  }
  return results;
}
