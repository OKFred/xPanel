import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { runBrowserFlow } from "./browser-flow.mjs";
import { runBackgroundWorkbenchFlow } from "./background-workbench-flow.mjs";
import {
  CdpClient,
  jsonEndpoint,
  openPageTarget,
  targets,
} from "./cdp-client.mjs";
import { availablePort, findChromium } from "./chromium.mjs";
import { e2eConfig } from "./config.mjs";
import { assertNoPageFailures, monitorPage } from "./diagnostics.mjs";
import { fixtureServer, listen } from "./fixture-server.mjs";
import { runHarFlow } from "./har-flow.mjs";
import { runLargeResponseFlow } from "./large-response-flow.mjs";
import { runLocalizationFlow } from "./localization-flow.mjs";
import { runRemoteFlow } from "./remote-flow.mjs";
import {
  generatePromoTile,
  generateStoreScreenshots,
} from "./store-assets.mjs";
import { invariant, waitFor } from "./utils.mjs";

export async function runChromiumE2e(config = e2eConfig) {
  const {
    captureStoreAssets,
    extensionRoot,
    manifestPath,
    storeAssetsRoot,
    workspaceRoot,
  } = config;
  let browserClient;
  let devtoolsClient;
  let panelClient;
  let inspectedClient;
  let storeWorkbenchClient;
  let storeWorkbenchTargetId;
  let chromeProcess;
  let profileRoot;
  const pageFailures = [];
  const fixture = fixtureServer();

  try {
    invariant(existsSync(manifestPath), "Build the MV3 extension before E2E.");
    const fixturePort = await listen(fixture);
    const fixtureOrigin = `http://127.0.0.1:${fixturePort}`;
    const inspectedStartUrl =
      "data:text/html,%3Ctitle%3ExPanel-E2E%3C%2Ftitle%3Efixture";
    const debugPort = await availablePort();
    const executable = await findChromium();
    profileRoot = await mkdtemp(join(tmpdir(), "xpanel-chromium-e2e-"));
    let stderr = "";
    chromeProcess = spawn(
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
        ...(captureStoreAssets ? ["--window-size=1280,800"] : []),
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${profileRoot}`,
        `--disable-extensions-except=${extensionRoot}`,
        `--load-extension=${extensionRoot}`,
        "--auto-open-devtools-for-tabs",
        inspectedStartUrl,
      ],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
    );
    chromeProcess.stderr.setEncoding("utf8");
    chromeProcess.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4_096);
    });

    const version = await waitFor(
      () => jsonEndpoint(debugPort, "/json/version"),
      `Chromium debugging endpoint${stderr ? ` (${stderr})` : ""}`,
    );
    browserClient = await new CdpClient(version.webSocketDebuggerUrl).open();
    const initialTargets = await waitFor(async () => {
      const entries = await targets(debugPort);
      const devtools = entries.find(
        (entry) => entry.type === "page" && entry.url.startsWith("devtools://"),
      );
      const inspected = entries.find(
        (entry) => entry.type === "page" && entry.url === inspectedStartUrl,
      );
      return devtools && inspected ? { devtools, inspected } : undefined;
    }, "DevTools and inspected page");
    devtoolsClient = await new CdpClient(
      initialTargets.devtools.webSocketDebuggerUrl,
    ).open();
    inspectedClient = await new CdpClient(
      initialTargets.inspected.webSocketDebuggerUrl,
    ).open();
    await inspectedClient.send("Page.enable");

    const panelKey = await waitFor(
      () =>
        devtoolsClient.evaluate(
          `Object.keys(UI.panels).find((key) => key.endsWith("xPanel"))`,
        ),
      "xPanel DevTools registration",
    );
    await devtoolsClient.evaluate(
      `InspectorFrontendAPI.showPanel(${JSON.stringify(panelKey)})`,
    );
    const panelTarget = await waitFor(async () => {
      const entries = await targets(debugPort);
      return entries.find(
        (entry) =>
          entry.type === "iframe" && entry.url.includes("devtools-panel.html"),
      );
    }, "xPanel DevTools panel");
    const panelUrl = new URL(panelTarget.url);
    const extensionOrigin = `${panelUrl.protocol}//${panelUrl.host}`;
    panelClient = await new CdpClient(panelTarget.webSocketDebuggerUrl).open();
    await monitorPage(panelClient, "devtools-panel", pageFailures);
    await waitFor(
      () =>
        panelClient.evaluate(
          `document.querySelector('.url-input')?.value === ""`,
        ),
      "xPanel workbench",
    );

    await runLocalizationFlow(panelClient);

    await inspectedClient.send("Page.navigate", {
      url: `${fixtureOrigin}/page`,
    });
    await waitFor(
      () =>
        inspectedClient.evaluate(
          `location.href === ${JSON.stringify(`${fixtureOrigin}/page`)}`,
        ),
      "fixture page navigation",
    );

    await runLargeResponseFlow(panelClient, fixtureOrigin);
    await runBrowserFlow(panelClient, fixtureOrigin);
    await runHarFlow(panelClient, inspectedClient);
    const remoteChecked = await runRemoteFlow(panelClient, config);
    const background = await runBackgroundWorkbenchFlow({
      browser: browserClient,
      debugPort,
      devtoolsTarget: initialTargets.devtools,
      extensionOrigin,
      failures: pageFailures,
      fixtureOrigin,
      panel: panelClient,
    });
    if (captureStoreAssets) {
      const standalonePage = await openPageTarget(
        browserClient,
        debugPort,
        `${extensionOrigin}/workbench.html`,
      );
      storeWorkbenchClient = standalonePage.client;
      storeWorkbenchTargetId = standalonePage.target.id;
      await monitorPage(
        storeWorkbenchClient,
        "store-standalone-workbench",
        pageFailures,
      );
      await waitFor(
        () =>
          storeWorkbenchClient.evaluate(
            `Boolean(document.querySelector(".workbench-shell"))`,
          ),
        "standalone store workbench",
      );
      await generateStoreScreenshots(
        storeWorkbenchClient,
        fixtureOrigin,
        storeAssetsRoot,
      );
      storeWorkbenchClient.close();
      storeWorkbenchClient = undefined;
      await browserClient.send("Target.closeTarget", {
        targetId: storeWorkbenchTargetId,
      });
      storeWorkbenchTargetId = undefined;
      await generatePromoTile({ workspaceRoot, storeAssetsRoot });
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    assertNoPageFailures(pageFailures);

    process.stdout.write(
      `Chromium MV3 E2E passed: method combobox, 318 KiB virtual response, DevTools panel, standalone recovery/cancel (${background.cancelLatencyMs.toFixed(1)} ms)${background.serviceWorkerTerminated ? ", service worker termination" : ""}, bilingual UI, Browser streaming/cancel, HAR import/select/persist${remoteChecked ? ", Remote Relay" : ""}${captureStoreAssets ? ", store assets" : ""}.\n`,
    );
  } finally {
    await new Promise((resolveClosed) => fixture.close(resolveClosed));
    panelClient?.close();
    inspectedClient?.close();
    storeWorkbenchClient?.close();
    if (browserClient && storeWorkbenchTargetId) {
      try {
        await browserClient.send("Target.closeTarget", {
          targetId: storeWorkbenchTargetId,
        });
      } catch {
        // Browser cleanup below also closes the disposable store page.
      }
    }
    devtoolsClient?.close();
    if (browserClient) {
      try {
        await browserClient.send("Browser.close");
      } catch {
        // Closing the browser can close the socket before the acknowledgement.
      }
      browserClient.close();
    }
    if (chromeProcess && chromeProcess.exitCode === null) chromeProcess.kill();
    if (profileRoot) {
      const resolvedProfile = resolve(profileRoot);
      const resolvedTemp = resolve(tmpdir());
      invariant(
        dirname(resolvedProfile) === resolvedTemp &&
          basename(resolvedProfile).startsWith("xpanel-chromium-e2e-"),
        "Refusing to remove an unexpected Chromium profile path.",
      );
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          await rm(resolvedProfile, { recursive: true, force: true });
          break;
        } catch (error) {
          if (attempt === 3) {
            process.stderr.write(
              `Could not remove the disposable Chromium profile: ${String(error)}\n`,
            );
            process.exitCode = 1;
            break;
          }
          await new Promise((resolveWait) => setTimeout(resolveWait, 250));
        }
      }
    }
  }
}
