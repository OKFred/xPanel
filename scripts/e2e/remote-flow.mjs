import { clickTextScript, setInput } from "./panel-actions.mjs";
import { invariant, waitFor } from "./utils.mjs";

export async function runRemoteFlow(
  panel,
  { remoteBaseUrl, remoteToken, remoteTargetUrl },
) {
  if (!remoteBaseUrl && !remoteToken && !remoteTargetUrl) return false;
  invariant(
    remoteBaseUrl && remoteToken && remoteTargetUrl,
    "Remote E2E requires XPANEL_REMOTE_BASE_URL, XPANEL_REMOTE_TOKEN, and XPANEL_REMOTE_TARGET_URL together.",
  );
  await waitFor(
    () =>
      panel.evaluate(
        `Boolean(document.querySelector(".sidebar > button.w-full:not(:disabled)"))`,
      ),
    "new request button",
  );
  await panel.evaluate(
    `document.querySelector(".sidebar > button.w-full").click()`,
    { userGesture: true },
  );
  await waitFor(
    () =>
      panel.evaluate(
        `document.querySelector('[aria-label="Request URL"]')?.value === ""`,
      ),
    "clean Remote request",
  );
  await panel.evaluate(`(() => {
    chrome.permissions.request = async () => true;
    chrome.permissions.contains = async () => true;
  })()`);
  await waitFor(
    () =>
      panel.evaluate(`Boolean(document.querySelector(".relay-manage-button"))`),
    "Relay manager button",
  );
  await panel.evaluate(
    `document.querySelector(".relay-manage-button").click()`,
    { userGesture: true },
  );
  await waitFor(
    () => panel.evaluate(`Boolean(document.querySelector(".relay-dialog"))`),
    "Relay manager",
  );
  const fields = await panel.evaluate(`(() => {
    const fields = document.querySelectorAll(".relay-profile-editor input.field");
    const set = (element, value) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    };
    set(fields[0], "Online acceptance");
    set(fields[1], ${JSON.stringify(remoteBaseUrl)});
    set(fields[2], ${JSON.stringify(remoteToken)});
    return fields.length;
  })()`);
  invariant(fields === 3, "Relay profile fields were not available.");
  await panel.evaluate(
    clickTextScript("Save", `document.querySelector(".relay-dialog")`),
    { userGesture: true },
  );
  await waitFor(
    () =>
      panel.evaluate(
        `document.querySelector(".relay-test-result")?.textContent.includes("Online acceptance")`,
      ),
    "saved Relay profile",
  );
  await panel.evaluate(
    clickTextScript("Cancel", `document.querySelector(".relay-dialog")`),
    { userGesture: true },
  );
  const profileId = await panel.evaluate(`(() => {
    const select = document.querySelector("select.executor-select");
    const option = [...select.options].find((entry) => entry.textContent.includes("Online acceptance"));
    if (!option) throw new Error("Saved Relay profile is missing.");
    select.value = option.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return option.value;
  })()`);
  invariant(profileId !== "browser", "Remote profile was not selectable.");
  await setInput(panel, '[aria-label="Request URL"]', remoteTargetUrl);
  await panel.evaluate(clickTextScript("Send"), { userGesture: true });
  const consent = await waitFor(
    () =>
      panel.evaluate(
        `document.querySelector('[role="alertdialog"]')?.innerText`,
      ),
    "Remote disclosure",
  );
  invariant(
    consent.includes(new URL(remoteTargetUrl).origin) &&
      consent.includes(new URL(remoteBaseUrl).host),
    "Remote disclosure omitted the target or Relay host.",
  );
  await panel.evaluate(
    `(() => {
      const dialog = document.querySelector('[role="alertdialog"]');
      const button = [...dialog.querySelectorAll("button")].find((entry) => entry.classList.contains("primary-button"));
      if (!button) throw new Error("Missing Remote confirmation button.");
      button.click();
    })()`,
    { userGesture: true },
  );
  let text;
  try {
    text = await waitFor(
      async () => {
        const content = await panel.evaluate("document.body.innerText");
        return content.includes("remote-e2e-ok") ? content : undefined;
      },
      "Remote Relay response",
      30_000,
    );
  } catch (error) {
    const snapshot = await panel.evaluate(
      `document.body.innerText.slice(-4000)`,
    );
    throw new Error(`Remote UI snapshot:\n${snapshot}`, { cause: error });
  }
  invariant(
    text.includes("Remote"),
    "Remote executor was not shown on response.",
  );
  return true;
}
