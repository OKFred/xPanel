import { clickTextScript, setInput } from "./panel-actions.mjs";
import { invariant, waitFor } from "./utils.mjs";
import { installHostAccessMock } from "./host-access-flow.mjs";

export async function runBrowserHeaderFlow(panel, fixtureOrigin) {
  // HAR persistence coverage reloads the panel, resetting the test permission shim.
  invariant(
    await installHostAccessMock(panel),
    "Could not isolate fixture host permission prompts.",
  );
  const headers = [":authority", ":method", ":path", ":scheme", "DNT"].map(
    (name) => ({ name, value: "captured" }),
  );
  headers.push({ name: "X-Test", value: "header-replay-ok" });
  await panel.evaluate(clickTextScript("Import"), { userGesture: true });
  await setInput(
    panel,
    '[aria-label="Import requests"] textarea',
    JSON.stringify({
      log: {
        version: "1.2",
        entries: [
          {
            request: {
              method: "GET",
              url: `${fixtureOrigin}/header-replay`,
              headers,
            },
          },
        ],
      },
    }),
  );
  await panel.evaluate(
    clickTextScript(
      "Import",
      `document.querySelector('[aria-label="Import requests"]')`,
    ),
    { userGesture: true },
  );
  await waitFor(
    () =>
      panel.evaluate(
        `!document.querySelector('dialog[aria-label="Import requests"]')`,
      ),
    "header fixture imported",
  );
  await panel.evaluate(clickTextScript("Options"), { userGesture: true });
  const toggle = `(() => {
    const label = [...document.querySelectorAll('label')].find(item => item.textContent.includes('Automatically filter browser-controlled headers'));
    const checkbox = label?.querySelector('input');
    if (!checkbox) throw new Error('Missing automatic header filter');
    checkbox.click();
    return checkbox.checked;
  })()`;
  invariant(
    await panel.evaluate(toggle, { userGesture: true }),
    "Header filter was not enabled.",
  );
  await panel.evaluate(clickTextScript("Send"), { userGesture: true });
  try {
    await waitFor(
      () =>
        panel.evaluate(
          `document.body.innerText.includes('header-replay-ok') && document.body.innerText.includes('Filtered 5 browser-controlled')`,
        ),
      "pseudo-header request reached fixture",
    );
  } catch (error) {
    const snapshot = await panel.evaluate(
      "document.body.innerText.slice(-5000)",
    );
    throw new Error(`Synthetic header replay snapshot: ${snapshot}`, {
      cause: error,
    });
  }
  invariant(
    await panel.evaluate(
      `!document.querySelector('.workspace [data-error="true"]')`,
    ),
    "Filtered pseudo-headers still caused an error.",
  );
  await panel.evaluate(toggle, { userGesture: true });
  await panel.evaluate(clickTextScript("New request"), { userGesture: true });
  console.log(
    "Chromium header replay passed: imported HTTP/2 pseudo-headers filtered, actual request delivered.",
  );
}
