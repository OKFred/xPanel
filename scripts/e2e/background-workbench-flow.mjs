import { CdpClient, openPageTarget, targets } from "./cdp-client.mjs";
import { monitorPage } from "./diagnostics.mjs";
import { installHostAccessMock } from "./host-access-flow.mjs";
import { clickTextScript, setInput } from "./panel-actions.mjs";
import { invariant, waitFor } from "./utils.mjs";

function extensionUrl(extensionOrigin, path) {
  return `${extensionOrigin}/${path}`;
}

async function waitForExtensionTarget(debugPort, extensionOrigin, path) {
  const expectedUrl = extensionUrl(extensionOrigin, path);
  return waitFor(async () => {
    const entries = await targets(debugPort);
    return entries.find((entry) => entry.url.startsWith(expectedUrl));
  }, `${path} target`);
}

async function terminateServiceWorker(browser, debugPort, extensionOrigin) {
  const entries = await targets(debugPort);
  const offscreen = entries.find((entry) =>
    entry.url.startsWith(extensionUrl(extensionOrigin, "offscreen.html")),
  );
  invariant(
    offscreen,
    "The slow request did not create an offscreen document.",
  );
  const serviceWorker = entries.find(
    (entry) =>
      entry.type === "service_worker" && entry.url.startsWith(extensionOrigin),
  );
  if (!serviceWorker) {
    process.stderr.write(
      "E2E note: the MV3 service worker was already idle; offscreen recovery still ran.\n",
    );
    return false;
  }
  const result = await browser.send("Target.closeTarget", {
    targetId: serviceWorker.id,
  });
  if (!result.success) {
    process.stderr.write(
      "E2E note: Chromium refused explicit service-worker termination.\n",
    );
    return false;
  }
  await waitFor(async () => {
    const current = await targets(debugPort);
    return (
      !current.some((entry) => entry.id === serviceWorker.id) &&
      current.some((entry) => entry.id === offscreen.id)
    );
  }, "service worker termination with offscreen survival");
  return true;
}

async function openStandaloneFromPopup(
  browser,
  debugPort,
  extensionOrigin,
  failures,
) {
  const popupPage = await openPageTarget(
    browser,
    debugPort,
    extensionUrl(extensionOrigin, "popup.html"),
  );
  await monitorPage(popupPage.client, "popup", failures);
  const popupStatus = await waitFor(async () => {
    const snapshot = await popupPage.client.evaluate(`(() => ({
      button: document.querySelector("button.popup-open")?.textContent,
      status: document.querySelector(".popup-status")?.innerText,
      running: Boolean(document.querySelector(".popup-status .spin")),
    }))()`);
    return snapshot.button && snapshot.status ? snapshot : undefined;
  }, "popup execution status");
  invariant(
    popupStatus.running,
    `Popup did not report the running background request: ${JSON.stringify(popupStatus)}`,
  );
  await popupPage.client
    .evaluate(`document.querySelector("button.popup-open").click(); true`, {
      userGesture: true,
    })
    .catch(() => undefined);

  const standaloneTarget = await waitForExtensionTarget(
    debugPort,
    extensionOrigin,
    "workbench.html",
  );
  const standalone = await openTargetClient(standaloneTarget);
  await monitorPage(standalone, "standalone", failures);
  await waitFor(
    () =>
      standalone.evaluate(
        `Boolean(document.querySelector(".workbench-shell"))`,
      ),
    "standalone workbench",
  );
  popupPage.client.close();
  return standalone;
}

async function openTargetClient(target) {
  const client = await new CdpClient(target.webSocketDebuggerUrl).open();
  await client.send("Runtime.enable");
  return client;
}

async function cancelFromStandalone(standalone, fixtureOrigin) {
  invariant(
    await installHostAccessMock(standalone),
    "Could not isolate standalone host permission prompts.",
  );
  await setInput(standalone, ".url-input", `${fixtureOrigin}/slow`);
  await standalone.evaluate(clickTextScript("Send"), { userGesture: true });
  await waitFor(async () => {
    const snapshot = await standalone.evaluate(`(() => ({
        phase: document.querySelector("[role=progressbar]")?.getAttribute("aria-label"),
        stop: Boolean(document.querySelector("button.stop-button")),
      }))()`);
    return snapshot.stop &&
      /upload|waiting|download/iu.test(snapshot.phase ?? "")
      ? snapshot
      : undefined;
  }, "active standalone Stop button");
  await standalone.evaluate(clickTextScript("Stop"), { userGesture: true });
  const cancelled = await waitFor(async () => {
    const text = await standalone.evaluate("document.body.innerText");
    return /cancelled/iu.test(text) ? text : undefined;
  }, "standalone cancellation");
  invariant(
    cancelled.includes("background-e2e-ok"),
    "Cancelling from standalone replaced the previous successful response.",
  );
}

export async function runBackgroundWorkbenchFlow({
  browser,
  debugPort,
  devtoolsTarget,
  extensionOrigin,
  failures,
  fixtureOrigin,
  panel,
}) {
  invariant(
    await installHostAccessMock(panel),
    "Could not isolate background host permission prompts.",
  );
  await setInput(panel, ".url-input", `${fixtureOrigin}/slow-complete`);
  await panel.evaluate(clickTextScript("Send"), { userGesture: true });
  await waitFor(async () => {
    const snapshot = await panel.evaluate(`(() => ({
        phase: document.querySelector("[role=progressbar]")?.getAttribute("aria-label"),
        stop: Boolean(document.querySelector("button.stop-button")),
      }))()`);
    return snapshot.stop &&
      /upload|waiting|download/iu.test(snapshot.phase ?? "")
      ? snapshot
      : undefined;
  }, "active background request");
  await waitForExtensionTarget(debugPort, extensionOrigin, "offscreen.html");

  const closed = await browser.send("Target.closeTarget", {
    targetId: devtoolsTarget.id,
  });
  invariant(closed.success, "Chromium refused to close DevTools.");
  const serviceWorkerTerminated = await terminateServiceWorker(
    browser,
    debugPort,
    extensionOrigin,
  );
  const standalone = await openStandaloneFromPopup(
    browser,
    debugPort,
    extensionOrigin,
    failures,
  );
  try {
    await waitFor(
      async () => {
        const text = await standalone.evaluate("document.body.innerText");
        return text.includes("background-e2e-ok") ? text : undefined;
      },
      "offscreen completion in standalone",
      30_000,
    );
  } catch (error) {
    const [snapshot, currentTargets] = await Promise.all([
      standalone.evaluate(`(() => ({
        text: document.body.innerText.slice(-6000),
        progress: document.querySelector("[role=progressbar]")?.getAttribute("aria-label"),
        stop: Boolean(document.querySelector("button.stop-button")),
      }))()`),
      targets(debugPort),
    ]);
    throw new Error(
      `Standalone recovery snapshot:\n${JSON.stringify(
        {
          serviceWorkerTerminated,
          snapshot,
          targets: currentTargets.map(({ id, type, url }) => ({
            id,
            type,
            url,
          })),
        },
        null,
        2,
      )}`,
      { cause: error },
    );
  }
  await cancelFromStandalone(standalone, fixtureOrigin);
  standalone.close();
  return { serviceWorkerTerminated };
}
