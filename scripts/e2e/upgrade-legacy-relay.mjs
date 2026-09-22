import { invariant, waitFor } from "./utils.mjs";
import { setPanelLanguage } from "./panel-actions.mjs";

const legacyId = "legacy-relay-upgrade";
export async function seedLegacyRelay(panel) {
  await panel.evaluate(`(async () => {
    await chrome.storage.local.set({
      remoteRelayProfilesV1: [{schemaVersion: 1, id: '${legacyId}', name: 'Legacy upgrade fixture', baseUrl: 'https://legacy.invalid', tokenStorage: 'local'}],
      remoteRelayTokensV1: {'${legacyId}': 'synthetic-old-token-never-reused'},
    });
    await chrome.storage.session.set({remoteExecutorSelectionV1: '${legacyId}'});
  })()`);
}

export async function verifyLegacyRelayDisabled(panel) {
  await setPanelLanguage(panel, "en");
  const snapshot = await panel.evaluate(`(async () => ({
    selected: document.querySelector('.executor-select').value,
    options: [...document.querySelector('.executor-select').options].map(option => option.value),
    newProfiles: (await chrome.storage.local.get('oneFetchProfilesV1')).oneFetchProfilesV1 ?? [],
    newTokenKeys: Object.keys((await chrome.storage.local.get('oneFetchTokensV1')).oneFetchTokensV1 ?? {}),
  }))()`);
  invariant(
    snapshot.selected === "browser" && !snapshot.options.includes(legacyId),
    "A legacy Relay became executable after upgrade.",
  );
  invariant(
    !snapshot.newProfiles.length && !snapshot.newTokenKeys.length,
    "Legacy addresses or credentials were silently migrated.",
  );
  await panel.evaluate(
    "document.querySelector('.relay-manage-button').click()",
    { userGesture: true },
  );
  await waitFor(
    () =>
      panel.evaluate(
        "document.querySelector('.relay-dialog')?.innerText.includes('Legacy upgrade fixture')",
      ),
    "read-only legacy profile",
  );
  const prompt = new Promise((resolve) =>
    panel.on("Page.javascriptDialogOpening", async () => {
      await panel.send("Page.handleJavaScriptDialog", { accept: true });
      resolve();
    }),
  );
  await panel.send("Page.enable");
  const clicked = panel.evaluate(
    "document.querySelector('.relay-profile-list section button').click()",
    { userGesture: true },
  );
  await Promise.all([prompt, clicked]);
  await waitFor(
    () =>
      panel.evaluate(
        "!document.querySelector('.relay-dialog')?.innerText.includes('Legacy upgrade fixture')",
      ),
    "legacy deletion reflected",
  );
  invariant(
    await panel.evaluate(`(async () => {
    const data = await chrome.storage.local.get(['remoteRelayProfilesV1', 'remoteRelayTokensV1']);
    return !data.remoteRelayProfilesV1.some(p => p.id === '${legacyId}') && !Object.hasOwn(data.remoteRelayTokensV1, '${legacyId}');
  })()`),
    "Explicit legacy cleanup retained the old profile or credential.",
  );
  await panel.evaluate(
    "document.querySelector('.relay-dialog header button').click()",
    { userGesture: true },
  );
}
