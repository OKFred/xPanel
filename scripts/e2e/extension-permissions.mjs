import { openPageTarget } from "./cdp-client.mjs";
import { waitFor } from "./utils.mjs";

// Use Chrome's own extension-management API in the disposable browser profile.
// Do not patch fetch, CORS, the manifest, or the extension permission response.
export async function grantTestHostAccess(browser, port, extensionId, origins) {
  const page = await openPageTarget(browser, port, "chrome://extensions");
  try {
    await waitFor(
      () =>
        page.client.evaluate(
          "Boolean(chrome.developerPrivate?.addHostPermission)",
        ),
      "Chrome extension manager",
    );
    for (const origin of origins) {
      await page.client.evaluate(
        `chrome.developerPrivate.addHostPermission(${JSON.stringify(extensionId)}, ${JSON.stringify(`${new URL(origin).origin}/*`)})`,
        { userGesture: true },
      );
    }
  } finally {
    page.client.close();
    await browser.send("Target.closeTarget", { targetId: page.target.id });
  }
}
