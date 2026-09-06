import {
  installHostAccessMock,
  runHostAccessFlow,
} from "./host-access-flow.mjs";
import { clickTextScript, setInput } from "./panel-actions.mjs";
import { invariant, waitFor } from "./utils.mjs";

export async function runBrowserFlow(panel, fixtureOrigin) {
  const override = await installHostAccessMock(panel);
  invariant(override, "Could not isolate host permission prompts in E2E.");

  await setInput(
    panel,
    '[aria-label="Request URL"]',
    `${fixtureOrigin}/stream`,
  );
  await panel.evaluate(clickTextScript("Send"), { userGesture: true });
  const observedPhases = new Set();
  const responseText = await waitFor(async () => {
    const snapshot = await panel.evaluate(`(() => ({
      phase: document.querySelector("[role=progressbar]")?.getAttribute("aria-label"),
      stop: Boolean(document.querySelector("button.stop-button")),
      text: document.body.innerText,
    }))()`);
    if (snapshot.phase) observedPhases.add(snapshot.phase);
    if (snapshot.stop) observedPhases.add("stop-visible");
    return snapshot.text.includes("browser-e2e-ok") ? snapshot.text : undefined;
  }, "Browser response");
  invariant(
    responseText.includes("200"),
    "Browser response status was not shown.",
  );
  invariant(observedPhases.has("stop-visible"), "Stop did not replace Send.");
  invariant(
    [...observedPhases].some((phase) => /Downloading/i.test(phase)),
    "Browser download progress was not observed.",
  );

  await setInput(panel, '[aria-label="Request URL"]', `${fixtureOrigin}/slow`);
  await panel.evaluate(clickTextScript("Send"), { userGesture: true });
  await waitFor(
    () =>
      panel.evaluate(`Boolean(document.querySelector("button.stop-button"))`),
    "Stop button",
  );
  await panel.evaluate(clickTextScript("Stop"), { userGesture: true });
  const cancelledText = await waitFor(async () => {
    const text = await panel.evaluate("document.body.innerText");
    return /cancelled/i.test(text) ? text : undefined;
  }, "cancelled request");
  invariant(
    cancelledText.includes("browser-e2e-ok"),
    "Cancelling replaced the previous successful response.",
  );

  await panel.evaluate(clickTextScript("Options"), { userGesture: true });
  const timeout = await panel.evaluate(
    `document.querySelector('[aria-label="Timeout (seconds)"]')?.value`,
  );
  invariant(timeout === "60", "New requests do not default to 60 seconds.");
  await runHostAccessFlow(panel);
}
