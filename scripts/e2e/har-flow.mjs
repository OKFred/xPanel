import { clickTextScript } from "./panel-actions.mjs";
import { invariant, waitFor } from "./utils.mjs";

export async function runHarFlow(panel, inspectedPage) {
  await inspectedPage.send("Page.enable");
  await inspectedPage.send("Page.reload", { ignoreCache: true });
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  await panel.evaluate(clickTextScript("Import"), { userGesture: true });
  await panel.evaluate(clickTextScript("Current Network HAR"), {
    userGesture: true,
  });
  await waitFor(
    () =>
      panel.evaluate(
        `document.querySelector('[aria-label="Import requests"] textarea')?.value.includes("captured?via=har")`,
      ),
    "captured HAR",
  );
  await panel.evaluate(
    clickTextScript(
      "Import",
      `document.querySelector('[aria-label="Import requests"]')`,
    ),
    { userGesture: true },
  );
  const requestCount = await waitFor(async () => {
    const count = await panel.evaluate(
      `document.querySelectorAll(".collection-group .request-link").length`,
    );
    return count >= 2 ? count : undefined;
  }, "imported HAR requests");
  await panel.evaluate(
    `(() => {
    const links = document.querySelectorAll(".collection-group .request-link");
    links[links.length - 1].click();
  })()`,
    { userGesture: true },
  );
  const selectedUrl = await panel.evaluate(
    `document.querySelector('[aria-label="Request URL"]')?.value`,
  );
  invariant(
    typeof selectedUrl === "string" && selectedUrl.includes("127.0.0.1"),
    "An imported sidebar request could not be selected.",
  );
  await panel.evaluate(`setTimeout(() => location.reload(), 0); true`);
  await waitFor(
    () =>
      panel.evaluate(
        `document.querySelectorAll(".collection-group .request-link").length >= ${requestCount}`,
      ),
    "persisted HAR requests",
  );
}
