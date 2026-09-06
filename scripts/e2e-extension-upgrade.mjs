import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CdpClient,
  jsonEndpoint,
  openPageTarget,
  targets,
} from "./e2e/cdp-client.mjs";
import { availablePort, findChromium } from "./e2e/chromium.mjs";
import {
  assertDisposablePath,
  buildSnapshot,
  cleanupUpgradeRoot,
  git,
  sameValues,
  workspaceRoot,
} from "./e2e/upgrade-worktrees.mjs";
import { invariant, waitFor } from "./e2e/utils.mjs";

const updateBaseline = JSON.parse(
  await readFile(
    join(
      workspaceRoot,
      "scripts",
      "fixtures",
      "extension-update-baseline-2.0.json",
    ),
    "utf8",
  ),
);
const expectedBaselineVersion = updateBaseline.chromiumBaselineVersion;
const expectedCurrentVersion = updateBaseline.targetVersion;
const expectedBaselinePermissions = updateBaseline.requiredPermissions;
const expectedCurrentPermissions = [
  ...updateBaseline.requiredPermissions,
  ...updateBaseline.expectedAddedWarninglessPermissions,
];
const optionalOrigins = updateBaseline.optionalHostPermissions;
const seed = {
  request: {
    id: "request-upgrade-e2e",
    name: "Upgrade persistence probe",
    method: "POST",
    url: "https://upgrade.invalid/v1/persisted",
    query: [
      { name: "source", value: "2.0.1", enabled: true, sensitive: false },
    ],
    headers: [
      {
        name: "X-XPanel-Upgrade",
        value: "persisted",
        enabled: true,
        sensitive: false,
      },
    ],
    auth: { kind: "none" },
    body: { kind: "json", text: '{"survives":true}' },
    options: {
      redirect: "follow",
      cookieMode: "include",
      timeoutMs: 60_000,
      proxy: null,
      tls: { verify: true },
    },
    source: { format: "manual" },
    favorite: true,
    warnings: [],
  },
  collection: {
    id: "collection-upgrade-e2e",
    name: "Upgrade survivors",
    description: "Created by the offline Chromium upgrade test.",
    requestIds: ["request-upgrade-e2e"],
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
  },
};

async function launchChromium({ extensionRoot, profileRoot, startUrl }) {
  const debugPort = await availablePort();
  const executable = await findChromium();
  let stderr = "";
  const processHandle = spawn(
    executable,
    [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-sync",
      "--metrics-recording-only",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileRoot}`,
      `--disable-extensions-except=${extensionRoot}`,
      `--load-extension=${extensionRoot}`,
      "--auto-open-devtools-for-tabs",
      startUrl,
    ],
    { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
  );
  processHandle.stderr.setEncoding("utf8");
  processHandle.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4_096);
  });
  const version = await waitFor(
    () => jsonEndpoint(debugPort, "/json/version"),
    `Chromium debugging endpoint${stderr ? ` (${stderr})` : ""}`,
    30_000,
  );
  const browser = await new CdpClient(version.webSocketDebuggerUrl).open();
  return { browser, debugPort, processHandle };
}

async function stopChromium(session) {
  if (!session) return;
  const exited = new Promise((resolveExit) => {
    if (session.processHandle.exitCode !== null) resolveExit(true);
    else session.processHandle.once("exit", () => resolveExit(true));
  });
  try {
    await session.browser.send("Browser.close");
  } catch {
    // Browser shutdown can close the socket before the acknowledgement.
  }
  session.browser.close();
  const closed = await Promise.race([
    exited,
    new Promise((resolveWait) => setTimeout(() => resolveWait(false), 5_000)),
  ]);
  if (!closed && session.processHandle.exitCode === null) {
    session.processHandle.kill();
    await exited;
  }
}

async function baselinePanel(session) {
  const initial = await waitFor(async () => {
    const entries = await targets(session.debugPort);
    const devtools = entries.find(
      (entry) => entry.type === "page" && entry.url.startsWith("devtools://"),
    );
    return devtools ? { devtools } : undefined;
  }, "baseline DevTools page");
  const devtools = await new CdpClient(
    initial.devtools.webSocketDebuggerUrl,
  ).open();
  const panelKey = await waitFor(
    () =>
      devtools.evaluate(
        `Object.keys(UI.panels).find((key) => key.endsWith("xPanel"))`,
      ),
    "baseline xPanel DevTools registration",
  );
  await devtools.evaluate(
    `InspectorFrontendAPI.showPanel(${JSON.stringify(panelKey)})`,
  );
  const target = await waitFor(async () => {
    const entries = await targets(session.debugPort);
    return entries.find(
      (entry) =>
        entry.type === "iframe" && entry.url.includes("devtools-panel.html"),
    );
  }, "baseline xPanel panel");
  const panel = await new CdpClient(target.webSocketDebuggerUrl).open();
  await panel.send("Runtime.enable");
  await waitFor(
    () => panel.evaluate(`Boolean(document.querySelector(".workspace"))`),
    "baseline xPanel workspace",
  );
  return { devtools, panel };
}

async function extensionSnapshot(client) {
  return client.evaluate(`(async () => {
    const granted = await chrome.permissions.getAll();
    const contains = Object.fromEntries(await Promise.all(
      ["storage", "offscreen", "alarms"].map(async (permission) => [
        permission,
        await chrome.permissions.contains({ permissions: [permission] }),
      ]),
    ));
    const platform = await chrome.runtime.getPlatformInfo();
    return {
      id: chrome.runtime.id,
      manifest: chrome.runtime.getManifest(),
      granted,
      contains,
      platform,
    };
  })()`);
}

async function seedBaseline(panel) {
  return panel.evaluate(`(async () => {
    const seed = ${JSON.stringify(seed)};
    const db = await new Promise((resolveOpen, reject) => {
      const request = indexedDB.open("xpanel", 1);
      request.onsuccess = () => resolveOpen(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction(["collections", "requests"], "readwrite");
    transaction.objectStore("collections").put(seed.collection);
    transaction.objectStore("requests").put(seed.request);
    await new Promise((resolveDone, reject) => {
      transaction.oncomplete = resolveDone;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    const version = db.version;
    db.close();
    return version;
  })()`);
}

async function upgradedDatabaseSnapshot(client) {
  return client.evaluate(`(async () => {
    const db = await new Promise((resolveOpen, reject) => {
      const request = indexedDB.open("xpanel");
      request.onsuccess = () => resolveOpen(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction(["collections", "requests"], "readonly");
    const read = (store, key) => new Promise((resolveRead, reject) => {
      const request = transaction.objectStore(store).get(key);
      request.onsuccess = () => resolveRead(request.result);
      request.onerror = () => reject(request.error);
    });
    const [collection, request] = await Promise.all([
      read("collections", ${JSON.stringify(seed.collection.id)}),
      read("requests", ${JSON.stringify(seed.request.id)}),
    ]);
    const snapshot = {
      version: db.version,
      stores: [...db.objectStoreNames],
      collection,
      request,
    };
    db.close();
    return snapshot;
  })()`);
}

async function verifyUpgradedWorkbench(session, extensionOrigin) {
  const page = await openPageTarget(
    session.browser,
    session.debugPort,
    `${extensionOrigin}/workbench.html`,
  );
  try {
    await waitFor(
      () =>
        page.client.evaluate(
          `Boolean(document.querySelector(".workbench-shell"))`,
        ),
      "upgraded standalone workbench",
    );
    const runtime = await extensionSnapshot(page.client);
    invariant(
      runtime.id === new URL(extensionOrigin).host,
      "Runtime ID changed.",
    );
    invariant(
      runtime.manifest.version === expectedCurrentVersion,
      `Upgraded runtime is ${runtime.manifest.version}.`,
    );
    invariant(
      sameValues(runtime.manifest.permissions, expectedCurrentPermissions),
      `Unexpected upgraded Manifest permissions: ${runtime.manifest.permissions}.`,
    );
    invariant(
      expectedCurrentPermissions.every((permission) =>
        runtime.granted.permissions.includes(permission),
      ),
      `The upgraded runtime did not receive all required permissions: ${runtime.granted.permissions}.`,
    );
    invariant(
      expectedCurrentPermissions.every(
        (permission) => runtime.contains[permission] === true,
      ),
      `A required permission is unavailable: ${JSON.stringify(runtime.contains)}.`,
    );
    invariant(
      typeof runtime.platform?.os === "string",
      "The upgraded extension runtime is not usable.",
    );
    await waitFor(async () => {
      const text = await page.client.evaluate("document.body.innerText");
      return text.includes(seed.collection.name) &&
        text.includes(seed.request.name)
        ? text
        : undefined;
    }, "persisted workspace records after upgrade");
    await page.client.evaluate(`(() => {
      const button = [...document.querySelectorAll("button.request-link")].find(
        (entry) => entry.textContent.includes(${JSON.stringify(seed.request.name)}),
      );
      if (!button) throw new Error("Persisted request is not selectable.");
      button.click();
      return true;
    })()`);
    const editor = await waitFor(async () => {
      const value = await page.client.evaluate(`(() => ({
          method: document.querySelector(".method-select")?.value,
          name: document.querySelector(".request-name")?.value,
          url: document.querySelector(".url-input")?.value,
        }))()`);
      return value.method === seed.request.method &&
        value.name === seed.request.name &&
        value.url === seed.request.url
        ? value
        : undefined;
    }, "persisted request selection");
    invariant(
      editor.method === seed.request.method &&
        editor.name === seed.request.name &&
        editor.url === seed.request.url,
      `Persisted request did not load correctly: ${JSON.stringify(editor)}.`,
    );
    const database = await upgradedDatabaseSnapshot(page.client);
    invariant(
      database.version === 2,
      `Database stayed at v${database.version}.`,
    );
    invariant(
      JSON.stringify(database.collection) === JSON.stringify(seed.collection) &&
        JSON.stringify(database.request) === JSON.stringify(seed.request),
      "The persisted collection or request was lost during migration.",
    );
    invariant(
      [
        "execution-bodies",
        "execution-files",
        "execution-payloads",
        "execution-responses",
        "executions",
      ].every((store) => database.stores.includes(store)),
      `The upgraded execution stores are incomplete: ${database.stores}.`,
    );
    return runtime;
  } finally {
    page.client.close();
  }
}

async function main() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "xpanel-upgrade-e2e-"));
  const baselineRoot = join(temporaryRoot, "baseline-worktree");
  const currentRoot = join(temporaryRoot, "current-worktree");
  const installRoot = join(temporaryRoot, "unpacked-xpanel");
  const profileRoot = join(temporaryRoot, "chromium-profile");
  const worktrees = [];
  let browserSession;

  try {
    invariant(
      /^[\da-f]{40}$/u.test(updateBaseline.chromiumBaselineCommit) &&
        typeof expectedBaselineVersion === "string",
      "The audited Chromium baseline fixture is incomplete.",
    );
    const baselineCommit = git([
      "rev-parse",
      `${updateBaseline.chromiumBaselineCommit}^{commit}`,
    ]);
    invariant(
      baselineCommit === updateBaseline.chromiumBaselineCommit,
      "The audited Chromium baseline commit did not resolve exactly.",
    );
    const currentCommit = git(["rev-parse", "HEAD^{commit}"]);
    worktrees.push(baselineRoot);
    const baselineBuild = await buildSnapshot(
      baselineCommit,
      baselineRoot,
      expectedBaselineVersion,
    );
    worktrees.push(currentRoot);
    const current = await buildSnapshot(
      currentCommit,
      currentRoot,
      expectedCurrentVersion,
    );
    invariant(
      baselineBuild.manifest.version === expectedBaselineVersion,
      `Baseline built version ${baselineBuild.manifest.version}.`,
    );
    invariant(
      current.manifest.version === expectedCurrentVersion,
      `HEAD built version ${current.manifest.version}.`,
    );
    invariant(
      sameValues(
        baselineBuild.manifest.permissions,
        expectedBaselinePermissions,
      ),
      `Baseline permissions do not match the 2.0 store line: ${baselineBuild.manifest.permissions}.`,
    );
    invariant(
      sameValues(
        baselineBuild.manifest.optional_host_permissions,
        optionalOrigins,
      ) &&
        sameValues(current.manifest.optional_host_permissions, optionalOrigins),
      "Optional host permissions changed across the upgrade.",
    );

    await cp(baselineBuild.extensionRoot, installRoot, { recursive: true });
    browserSession = await launchChromium({
      extensionRoot: installRoot,
      profileRoot,
      startUrl: "data:text/html,%3Ctitle%3ExPanel-Upgrade-E2E%3C%2Ftitle%3E",
    });
    const baselineUi = await baselinePanel(browserSession);
    const baselineRuntime = await extensionSnapshot(baselineUi.panel);
    invariant(
      baselineRuntime.manifest.version === expectedBaselineVersion,
      "Chromium did not load the baseline extension.",
    );
    invariant(
      expectedBaselinePermissions.every((permission) =>
        baselineRuntime.granted.permissions.includes(permission),
      ) &&
        baselineRuntime.contains.storage === true &&
        baselineRuntime.contains.offscreen === false &&
        baselineRuntime.contains.alarms === false,
      `Baseline permissions are not isolated to the 2.0 capability set: ${JSON.stringify(baselineRuntime)}.`,
    );
    invariant(
      (await seedBaseline(baselineUi.panel)) === 1,
      "Baseline data was not stored in IndexedDB v1.",
    );
    const extensionOrigin = `chrome-extension://${baselineRuntime.id}`;
    baselineUi.panel.close();
    baselineUi.devtools.close();
    await stopChromium(browserSession);
    browserSession = undefined;

    assertDisposablePath(installRoot, temporaryRoot, "unpacked-xpanel");
    await rm(installRoot, { force: true, recursive: true });
    await cp(current.extensionRoot, installRoot, { recursive: true });
    browserSession = await launchChromium({
      extensionRoot: installRoot,
      profileRoot,
      startUrl: "about:blank",
    });
    const upgradedRuntime = await verifyUpgradedWorkbench(
      browserSession,
      extensionOrigin,
    );
    invariant(
      upgradedRuntime.id === baselineRuntime.id,
      "The unpacked extension ID changed across the upgrade.",
    );
    process.stdout.write(
      `Chromium unpacked-extension upgrade passed: ${expectedBaselineVersion} [storage] -> ${expectedCurrentVersion} [storage, offscreen, alarms]; stable ID, enabled runtime, selectable collection/request, and IndexedDB v1 -> v2 migration verified.\n`,
    );
  } finally {
    await stopChromium(browserSession);
    await cleanupUpgradeRoot(temporaryRoot, worktrees);
  }
}

await main();
