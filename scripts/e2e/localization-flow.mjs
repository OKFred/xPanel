import { invariant, waitFor } from "./utils.mjs";

export async function runLocalizationFlow(panel) {
  const languageSelector = ".sidebar-footer button.icon-button";
  let languageLabel = await panel.evaluate(
    `document.querySelector(${JSON.stringify(languageSelector)})?.getAttribute("aria-label")`,
  );
  invariant(
    languageLabel === "Switch language" || languageLabel === "切换语言",
    "The language switch did not expose a localized label.",
  );
  if (languageLabel === "切换语言") {
    await panel.evaluate(
      `document.querySelector(${JSON.stringify(languageSelector)}).click(); true`,
      { userGesture: true },
    );
    await waitFor(
      () =>
        panel.evaluate(
          `document.querySelector('[aria-label="Request URL"]')?.value === ""`,
        ),
      "English interface",
    );
  }

  await panel.evaluate(
    `document.querySelector(${JSON.stringify(languageSelector)}).click(); true`,
    { userGesture: true },
  );
  const chineseSnapshot = await waitFor(async () => {
    const snapshot = await panel.evaluate(`(() => ({
        localizedUrl: Boolean(document.querySelector('[aria-label="请求 URL"]')),
        localizedTabs: Boolean(document.querySelector('nav[aria-label="请求编辑页签"]')),
        text: document.body.innerText,
      }))()`);
    return snapshot.localizedUrl &&
      snapshot.localizedTabs &&
      snapshot.text.includes("MV3 · 本地优先") &&
      snapshot.text.includes("添加")
      ? snapshot
      : undefined;
  }, "Chinese interface");
  invariant(
    chineseSnapshot.localizedUrl,
    "The request URL label was not localized.",
  );
  invariant(
    chineseSnapshot.localizedTabs,
    "The request tabs were not localized.",
  );

  await panel.evaluate(
    `document.querySelector(${JSON.stringify(languageSelector)}).click(); true`,
    { userGesture: true },
  );
  await waitFor(
    () =>
      panel.evaluate(
        `document.querySelector('[aria-label="Request URL"]')?.value === ""`,
      ),
    "restored English interface",
  );
  languageLabel = await panel.evaluate(
    `document.querySelector(${JSON.stringify(languageSelector)})?.getAttribute("aria-label")`,
  );
  invariant(languageLabel === "Switch language", "English was not restored.");
}
