import { openPageTarget, targets } from "./cdp-client.mjs";
import {
  openStandaloneFromPopup,
  terminateServiceWorker,
} from "./background-workbench-flow.mjs";
import { monitorPage } from "./diagnostics.mjs";
import { clickTextScript, setInput } from "./panel-actions.mjs";
import { invariant, waitFor } from "./utils.mjs";

// No permission mocks: reuse the real optional grants and session token from
// runRemoteFlow, then destroy the sending interface while the fetch is active.
export async function runRemoteBackgroundFlow({
  browser,
  debugPort,
  extensionOrigin,
  failures,
  origin,
}) {
  const opened = await openPageTarget(
    browser,
    debugPort,
    `${extensionOrigin}/workbench.html`,
  );
  let panel = opened.client;
  await monitorPage(panel, "remote-background-start", failures);
  await waitFor(
    () =>
      panel.evaluate(
        "Boolean(document.querySelector('select.executor-select option:not([value=browser])'))",
      ),
    "remote profile restored",
  );
  await panel.evaluate(`(() => {
    const select = document.querySelector('select.executor-select');
    select.value = [...select.options].find(option => option.value !== 'browser').value;
    select.dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
  await setInput(panel, ".url-input", `${origin}/slow`);
  await panel.evaluate(clickTextScript("Send"), { userGesture: true });
  await waitFor(
    () =>
      panel.evaluate(
        "document.querySelector('[role=progressbar]')?.getAttribute('aria-label')?.includes('Downloading')",
      ),
    "remote background stream",
  );
  // Close every workbench, including the one used for the Browser recovery.
  for (const target of await targets(debugPort)) {
    if (target.url.startsWith(`${extensionOrigin}/workbench.html`))
      await browser.send("Target.closeTarget", { targetId: target.id });
  }
  panel.close();
  await terminateServiceWorker(browser, debugPort, extensionOrigin);
  panel = await openStandaloneFromPopup(
    browser,
    debugPort,
    extensionOrigin,
    failures,
  );
  try {
    await waitFor(
      () =>
        panel.evaluate(`document.body.innerText.includes('remote-slow') &&
      /Body integrity\\s*:\\s*Verified\\b/.test(document.querySelector('.one-fetch-result')?.innerText ?? '')`),
      "remote background verified completion",
      30_000,
    );
    await setInput(panel, ".url-input", `${origin}/slow`);
    await panel.evaluate(clickTextScript("Send"), { userGesture: true });
    await waitFor(
      () =>
        panel.evaluate("Boolean(document.querySelector('button.stop-button'))"),
      "second remote execution",
    );
    const observer = await openPageTarget(
      browser,
      debugPort,
      `${extensionOrigin}/workbench.html`,
    );
    await monitorPage(observer.client, "remote-background-cancel", failures);
    try {
      await waitFor(
        () =>
          observer.client.evaluate(
            "Boolean(document.querySelector('button.stop-button'))",
          ),
        "cross-interface remote Stop",
      );
      await observer.client.evaluate(clickTextScript("Stop"), {
        userGesture: true,
      });
      await waitFor(
        () =>
          panel.evaluate(
            "/cancelled/i.test(document.querySelector('[data-error=true]')?.innerText ?? '')",
          ),
        "remote cancellation reflected at sender",
      );
      invariant(
        await panel.evaluate("document.body.innerText.includes('remote-slow')"),
        "Cross-interface cancellation lost the last successful body.",
      );
    } finally {
      observer.client.close();
      await browser.send("Target.closeTarget", {
        targetId: observer.target.id,
      });
    }
  } finally {
    panel.close();
  }
  process.stdout.write(
    "Remote background passed: all workbenches closed, service worker terminated, Popup recovery, digest verified, cross-interface Stop.\n",
  );
}
