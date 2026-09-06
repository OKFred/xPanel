import { invariant } from "./utils.mjs";

const BLOCKED_ARIA_HIDDEN = /Blocked aria-hidden/iu;
const UNHANDLED_MARKER = "[xpanel-e2e-unhandled]";

function remoteValue(value) {
  if (typeof value?.value === "string") return value.value;
  if (value?.value !== undefined) return JSON.stringify(value.value);
  return value?.description ?? value?.unserializableValue ?? "";
}

function exceptionText(params) {
  const details = params.exceptionDetails ?? {};
  return (
    details.exception?.description ??
    details.exception?.value ??
    details.text ??
    "Unidentified runtime exception"
  );
}

export async function monitorPage(client, label, failures) {
  const record = (kind, message) => {
    failures.push({ kind, label, message: String(message) });
  };
  client.on("Runtime.exceptionThrown", (params) =>
    record("exception", exceptionText(params)),
  );
  client.on("Runtime.consoleAPICalled", (params) => {
    const text = (params.args ?? []).map(remoteValue).join(" ");
    if (
      params.type === "error" ||
      params.type === "assert" ||
      text.includes(UNHANDLED_MARKER) ||
      BLOCKED_ARIA_HIDDEN.test(text)
    ) {
      record(`console.${params.type}`, text);
    }
  });
  client.on("Log.entryAdded", ({ entry }) => {
    if (BLOCKED_ARIA_HIDDEN.test(entry?.text ?? "")) {
      record("aria-hidden", entry.text);
    }
  });
  await Promise.all([client.send("Runtime.enable"), client.send("Log.enable")]);
  await client.evaluate(`(() => {
    if (globalThis.__xpanelE2eErrorHandlers) return true;
    globalThis.__xpanelE2eErrorHandlers = true;
    addEventListener("error", (event) => {
      console.error(${JSON.stringify(UNHANDLED_MARKER)}, "error", event.message);
    });
    addEventListener("unhandledrejection", (event) => {
      const reason = event.reason instanceof Error
        ? event.reason.stack ?? event.reason.message
        : String(event.reason);
      console.error(${JSON.stringify(UNHANDLED_MARKER)}, "unhandledrejection", reason);
    });
    return true;
  })()`);
}

export function assertNoPageFailures(failures) {
  invariant(
    failures.length === 0,
    failures
      .map(({ kind, label, message }) => `[${label}] ${kind}: ${message}`)
      .join("\n"),
  );
}
