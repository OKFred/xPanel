import { invariant, waitFor } from "./utils.mjs";

export function inputScript(selector, value) {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
      throw new Error("Missing input: " + ${JSON.stringify(selector)});
    }
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event("input", { bubbles: true }));
    return element.value;
  })()`;
}

export function clickTextScript(text, scope = "document") {
  return `(() => {
    const root = ${scope};
    const button = [...root.querySelectorAll("button")].find(
      (candidate) => candidate.textContent.trim() === ${JSON.stringify(text)},
    );
    if (!button) throw new Error("Missing button: " + ${JSON.stringify(text)});
    button.click();
    return true;
  })()`;
}

export async function setInput(panel, selector, value) {
  const actual = await panel.evaluate(inputScript(selector, value));
  invariant(actual === value, `Could not set ${selector}.`);
}

export async function setPanelLanguage(panel, language) {
  const selector = ".sidebar-footer button.icon-button";
  const desiredLabel = language === "zh_CN" ? "切换语言" : "Switch language";
  const currentLabel = await waitFor(async () => {
    const label = await panel.evaluate(
      `document.querySelector(${JSON.stringify(selector)})?.getAttribute("aria-label")`,
    );
    return label === "切换语言" || label === "Switch language"
      ? label
      : undefined;
  }, "language switch");
  if (currentLabel !== desiredLabel) {
    await panel.evaluate(
      `document.querySelector(${JSON.stringify(selector)}).click(); true`,
      { userGesture: true },
    );
  }
  await waitFor(
    () =>
      panel.evaluate(
        `document.querySelector(${JSON.stringify(selector)})?.getAttribute("aria-label") === ${JSON.stringify(desiredLabel)}`,
      ),
    `${language} interface`,
  );
}

export async function fillFirstInputs(panel, values) {
  const count = await panel.evaluate(`(() => {
    const fields = [...document.querySelectorAll(".relay-profile-editor input.field")];
    const set = (element, value) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const values = ${JSON.stringify(values)};
    values.forEach((value, index) => set(fields[index], value));
    return fields.length;
  })()`);
  invariant(count >= values.length, "Relay profile fields were not available.");
}
