const ALL_HTTP_HOST_ORIGINS = ["http://*/*", "https://*/*"];

async function waitForText(panel, text, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      await panel.evaluate(
        `document.body.innerText.includes(${JSON.stringify(text)})`,
      )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for host-access text: ${text}`);
}

async function clickButton(panel, text) {
  const clicked = await panel.evaluate(
    `(() => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => candidate.textContent.trim() === ${JSON.stringify(text)});
    if (!button) return false;
    button.click();
    return true;
  })()`,
    { userGesture: true },
  );
  if (!clicked) throw new Error(`Could not find host-access action: ${text}`);
}

export async function installHostAccessMock(panel) {
  return panel.evaluate(`(() => {
    const state = { allSites: false, requests: [], removals: [] };
    globalThis.__xpanelHostAccessE2E = state;
    const allOrigins = ${JSON.stringify(ALL_HTTP_HOST_ORIGINS)};
    const isAllSites = (origins = []) =>
      allOrigins.every((origin) => origins.includes(origin));
    const request = async ({ origins = [] }) => {
      state.requests.push([...origins]);
      if (isAllSites(origins)) state.allSites = true;
      return true;
    };
    const contains = async ({ origins = [] }) =>
      isAllSites(origins) ? state.allSites : true;
    const getAll = async () => ({ origins: state.allSites ? [...allOrigins] : [] });
    const remove = async ({ origins = [] }) => {
      state.removals.push([...origins]);
      if (isAllSites(origins)) state.allSites = false;
      return true;
    };
    chrome.permissions.request = request;
    chrome.permissions.contains = contains;
    chrome.permissions.getAll = getAll;
    chrome.permissions.remove = remove;
    return chrome.permissions.request === request &&
      chrome.permissions.contains === contains &&
      chrome.permissions.getAll === getAll &&
      chrome.permissions.remove === remove;
  })()`);
}

export async function runHostAccessFlow(panel) {
  await waitForText(panel, "Ask per domain");
  await clickButton(panel, "Allow all sites once");
  await waitForText(panel, "All HTTP/HTTPS sites allowed");

  const granted = await panel.evaluate(`(() => {
    const state = globalThis.__xpanelHostAccessE2E;
    const expected = ${JSON.stringify(ALL_HTTP_HOST_ORIGINS)};
    return state.allSites && state.requests.some((origins) =>
      expected.length === origins.length && expected.every((value, index) => value === origins[index]));
  })()`);
  if (!granted)
    throw new Error("All-site access did not request both wildcard origins.");

  await clickButton(panel, "Clear access and ask per domain");
  await waitForText(panel, "Ask per domain");
  const revoked = await panel.evaluate(`(() => {
    const state = globalThis.__xpanelHostAccessE2E;
    return !state.allSites && state.removals.length === 1;
  })()`);
  if (!revoked) throw new Error("All-site access was not revoked cleanly.");
}
