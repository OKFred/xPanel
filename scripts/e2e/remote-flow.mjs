import { clickTextScript, setInput } from "./panel-actions.mjs";
import { invariant, waitFor } from "./utils.mjs";
import { runRemoteResultChecks } from "./remote-result-checks.mjs";
import { runRemoteConformanceFlow } from "./remote-conformance-flow.mjs";

export async function runRemoteFlow(
  panel,
  {
    remoteControlUrl,
    remoteGatewayUrl,
    remoteToken,
    remoteTargetUrl,
    remoteFixtureKind,
    remoteExpectedMarker = "remote-e2e-ok",
    remoteIntegrity = "verified",
  },
) {
  if (
    !remoteControlUrl &&
    !remoteGatewayUrl &&
    !remoteToken &&
    !remoteTargetUrl
  )
    return false;
  invariant(
    remoteControlUrl && remoteGatewayUrl && remoteToken && remoteTargetUrl,
    "one-fetch E2E requires Control URL, Gateway URL, token, and synthetic target URL together.",
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
    set(fields[1], ${JSON.stringify(remoteControlUrl)});
    set(fields[2], ${JSON.stringify(remoteGatewayUrl)});
    set(fields[3], ${JSON.stringify(remoteToken)});
    const loopback = document.querySelector('.relay-profile-editor input[type=checkbox]');
    if (${JSON.stringify(remoteControlUrl.startsWith("http:"))} && !loopback.checked) loopback.click();
    return fields.length;
  })()`);
  invariant(fields === 4, "one-fetch profile fields were not available.");
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
  const access = await panel.evaluate(
    `chrome.permissions.request({origins: ${JSON.stringify([`${new URL(remoteControlUrl).origin}/*`, `${new URL(remoteGatewayUrl).origin}/*`])}})`,
    { userGesture: true },
  );
  invariant(
    access,
    "Chrome has not actually granted one-fetch service host access.",
  );
  await panel.send("Network.enable");
  panel.on("Network.loadingFailed", (event) => {
    process.stdout.write(
      `one-fetch network diagnostic: ${JSON.stringify({ error: event.errorText, cors: event.corsErrorStatus })}\n`,
    );
  });
  await panel.evaluate(clickTextScript("Send"), { userGesture: true });
  const consent = await waitFor(
    () =>
      panel.evaluate(`(() => {
        const dialog = document.querySelector('[role="alertdialog"]');
        if (dialog) return dialog.innerText;
        const error = document.querySelector('[data-error=true]');
        if (error?.textContent) throw new Error(error.textContent);
        return null;
      })()`),
    "Remote disclosure",
  );
  invariant(
    consent.includes(new URL(remoteTargetUrl).origin) &&
      consent.includes(new URL(remoteGatewayUrl).host),
    "Remote disclosure omitted the target or Relay host.",
  );
  await panel.evaluate(
    `(() => {
      const dialog = document.querySelector('[role="alertdialog"]');
      const trust = dialog.querySelector('input[type=checkbox]');
      if (trust && !trust.checked) trust.click();
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
        return content.includes(remoteExpectedMarker) ? content : undefined;
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
  await waitFor(
    () =>
      panel.evaluate(
        remoteIntegrity === "verified"
          ? `/Body integrity\\s*:\\s*Verified\\b/.test(document.querySelector('.one-fetch-result[data-source="target"]')?.innerText ?? '')`
          : `document.querySelector('.one-fetch-result[data-source="target"]')?.innerText.includes('report-digest-unavailable')`,
      ),
    "verified one-fetch result",
    10_000,
  );
  if (remoteFixtureKind === "xpanel-synthetic-v1")
    await runRemoteResultChecks(panel, new URL(remoteTargetUrl).origin);
  if (remoteFixtureKind === "one-fetch-conformance")
    await runRemoteConformanceFlow(
      panel,
      new URL(remoteTargetUrl).origin,
      remoteIntegrity,
    );
  await panel.evaluate(
    `(() => { const select = document.querySelector('select.executor-select'); select.value = 'browser'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`,
  );
  return true;
}
