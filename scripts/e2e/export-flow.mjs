import { clickTextScript, setInput } from "./panel-actions.mjs";
import { invariant, waitFor } from "./utils.mjs";

const dialogSelector = 'dialog[aria-label="Export requests"]';

async function exportSnapshot(panel) {
  return panel.evaluate(`(() => {
    const dialog = document.querySelector(${JSON.stringify(dialogSelector)});
    if (!dialog?.open) return null;
    return {
      hint: dialog.querySelector('[role="alert"]')?.textContent ?? '',
      preview: dialog.querySelector('textarea')?.value ?? '',
      disabled: [...dialog.querySelectorAll('footer button')].every(button => button.disabled),
      enabled: [...dialog.querySelectorAll('footer button')].every(button => !button.disabled),
      globalError: Boolean(document.querySelector('.workspace [data-error="true"]')),
    };
  })()`);
}

async function selectFormat(panel, format) {
  await panel.evaluate(`(() => {
    const select = document.querySelector(${JSON.stringify(dialogSelector)}).querySelector('select');
    select.value = ${JSON.stringify(format)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
}

async function closeExport(panel) {
  await panel.evaluate(
    `(() => {
    document.querySelector(${JSON.stringify(dialogSelector)}).querySelector('header button').click();
    return true;
  })()`,
    { userGesture: true },
  );
  await waitFor(
    () =>
      panel.evaluate(
        `!document.querySelector(${JSON.stringify(dialogSelector)})`,
      ),
    "closed export dialog",
  );
}

export async function runExportFlow(panel) {
  await panel.evaluate(clickTextScript("Export"), { userGesture: true });
  const empty = await waitFor(async () => {
    const state = await exportSnapshot(panel);
    return state?.hint.includes("current request has no URL") && state.disabled
      ? state
      : undefined;
  }, "empty draft export guidance");
  invariant(
    !empty.globalError && empty.preview === "",
    "Blank export leaked a global error or stale preview.",
  );

  await selectFormat(panel, "xpanel-collection");
  await waitFor(async () => {
    const state = await exportSnapshot(panel);
    return (
      state?.enabled &&
      !state.hint &&
      state.preview.includes('"schemaVersion": 1')
    );
  }, "collection backup without a current URL");
  await closeExport(panel);

  await setInput(
    panel,
    '[aria-label="Request URL"]',
    "https://example.invalid/export-probe",
  );
  await panel.evaluate(clickTextScript("Export"), { userGesture: true });
  await selectFormat(panel, "curl-bash");
  await waitFor(async () => {
    const state = await exportSnapshot(panel);
    return (
      state?.enabled &&
      !state.hint &&
      state.preview.includes("https://example.invalid/export-probe")
    );
  }, "valid cURL preview");
  await closeExport(panel);

  await setInput(panel, '[aria-label="Request URL"]', "{{baseUrl}}/api");
  await panel.evaluate(clickTextScript("Export"), { userGesture: true });
  const invalid = await waitFor(async () => {
    const state = await exportSnapshot(panel);
    return state?.disabled && state.hint.includes("valid, complete HTTP(S) URL")
      ? state
      : undefined;
  }, "invalid URL export guidance");
  invariant(
    !invalid.globalError && invalid.preview === "",
    "Invalid export retained the previous cURL preview.",
  );
  await closeExport(panel);
  await setInput(panel, '[aria-label="Request URL"]', "");
  process.stdout.write(
    "Chromium export regression passed: blank draft, collection backup, valid preview, invalid URL and stale output guards.\n",
  );
}
