import { installHostAccessMock } from "./host-access-flow.mjs";
import { clickTextScript, setInput } from "./panel-actions.mjs";
import { invariant, waitFor } from "./utils.mjs";

async function choosePostWithCombobox(panel) {
  await panel.evaluate(`(() => {
    const input = document.querySelector('[role="combobox"]');
    if (!(input instanceof HTMLInputElement)) throw new Error("Method combobox missing.");
    input.focus();
    return input.getAttribute("aria-expanded") === "true";
  })()`);
  for (const [type, key, code, windowsVirtualKeyCode] of [
    ["keyDown", "ArrowDown", "ArrowDown", 40],
    ["keyUp", "ArrowDown", "ArrowDown", 40],
    ["keyDown", "Enter", "Enter", 13],
    ["keyUp", "Enter", "Enter", 13],
  ]) {
    await panel.send("Input.dispatchKeyEvent", {
      type,
      key,
      code,
      windowsVirtualKeyCode,
    });
  }
  const state = await panel.evaluate(`(() => {
    const input = document.querySelector('[role="combobox"]');
    return {
      value: input?.value,
      expanded: input?.getAttribute("aria-expanded"),
      invalid: input?.getAttribute("aria-invalid"),
    };
  })()`);
  invariant(state.value === "POST", "The method combobox did not select POST.");
  invariant(state.expanded === "false", "The method combobox did not close.");
  invariant(
    state.invalid !== "true",
    "POST was reported as an invalid method.",
  );
}

async function selectJsonBody(panel) {
  await panel.evaluate(clickTextScript("Body"), { userGesture: true });
  await panel.evaluate(`(() => {
    const select = document.querySelector(".body-editor select");
    if (!(select instanceof HTMLSelectElement)) throw new Error("Body type selector missing.");
    select.value = "json";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  await waitFor(
    () =>
      panel.evaluate(
        `Boolean(document.querySelector(".body-editor textarea"))`,
      ),
    "JSON request body editor",
  );
  await setInput(panel, ".body-editor textarea", "{}");
}

async function viewerSnapshot(panel) {
  return panel.evaluate(`(() => {
    const viewer = document.querySelector(".response-document-viewer");
    if (!(viewer instanceof HTMLElement)) return null;
    return {
      activeTab: document.querySelector(".response-tabs button[data-active=true]")?.textContent.trim(),
      rows: viewer.querySelectorAll(".viewer-row").length,
      text: viewer.innerText.slice(0, 1000),
      clientHeight: viewer.clientHeight,
      clientWidth: viewer.clientWidth,
      scrollHeight: viewer.scrollHeight,
      scrollWidth: viewer.scrollWidth,
      overflowX: getComputedStyle(viewer).overflowX,
      overflowY: getComputedStyle(viewer).overflowY,
    };
  })()`);
}

async function activateResponseTab(panel, label) {
  await panel.evaluate(
    clickTextScript(label, `document.querySelector(".response-pane")`),
    { userGesture: true },
  );
  return waitFor(async () => {
    const snapshot = await viewerSnapshot(panel);
    return snapshot?.rows && snapshot.activeTab === label
      ? snapshot
      : undefined;
  }, `${label} response viewer`);
}

export async function runLargeResponseFlow(panel, fixtureOrigin) {
  invariant(
    await installHostAccessMock(panel),
    "Could not isolate host permission prompts for the large response.",
  );
  await choosePostWithCombobox(panel);
  await selectJsonBody(panel);
  await setInput(
    panel,
    '[aria-label="Request URL"]',
    `${fixtureOrigin}/large-json`,
  );
  await panel.evaluate(clickTextScript("Send"), { userGesture: true });

  let pretty;
  try {
    pretty = await waitFor(
      async () => {
        const snapshot = await viewerSnapshot(panel);
        const body = await panel.evaluate("document.body.innerText");
        return body.includes("200") &&
          snapshot?.text.includes("large-json-e2e-ok")
          ? snapshot
          : undefined;
      },
      "318 KiB JSON response",
      30_000,
    );
  } catch (error) {
    const snapshot = await panel.evaluate(`(() => ({
      body: document.body.innerText.slice(-5000),
      viewer: document.querySelector(".response-document-viewer")?.innerText.slice(0, 1000),
      viewerError: document.querySelector(".viewer-error")?.innerText,
    }))()`);
    throw new Error(
      `Large response UI snapshot:\n${JSON.stringify(snapshot, null, 2)}`,
      { cause: error },
    );
  }
  invariant(pretty.rows <= 200, "Pretty rendered more than 200 DOM rows.");
  invariant(
    pretty.scrollHeight > pretty.clientHeight,
    "Pretty response did not expose vertical scrolling.",
  );
  invariant(
    pretty.overflowX === "auto" && pretty.overflowY === "auto",
    "Pretty response is not an independent two-axis scroll container.",
  );
  const prettyScrollTop = await panel.evaluate(`(() => {
    const viewer = document.querySelector(".response-document-viewer");
    viewer.scrollTop = 1000;
    viewer.dispatchEvent(new Event("scroll"));
    return viewer.scrollTop;
  })()`);
  invariant(prettyScrollTop > 0, "Pretty response could not be scrolled.");

  const raw = await activateResponseTab(panel, "Raw");
  invariant(raw.rows <= 200, "Raw rendered more than 200 DOM rows.");
  invariant(
    raw.scrollWidth > raw.clientWidth,
    "Raw response did not expose horizontal scrolling for a long line.",
  );
  const rawScrollLeft = await panel.evaluate(`(() => {
    const viewer = document.querySelector(".response-document-viewer");
    viewer.scrollLeft = 1000;
    viewer.dispatchEvent(new Event("scroll"));
    return viewer.scrollLeft;
  })()`);
  invariant(rawScrollLeft > 0, "Raw response could not be scrolled.");

  const prettyAgain = await activateResponseTab(panel, "Pretty");
  invariant(
    prettyAgain.rows <= 200 &&
      prettyAgain.scrollHeight > prettyAgain.clientHeight,
    "Pretty viewer did not recover its virtualized scroll document.",
  );
}
