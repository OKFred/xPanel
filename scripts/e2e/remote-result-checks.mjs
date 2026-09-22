import { clickTextScript, setInput } from "./panel-actions.mjs";
import { invariant, waitFor } from "./utils.mjs";

export async function send(panel, url) {
  await setInput(panel, ".url-input", url);
  await panel.evaluate(`(() => {
    const cycle = { started: false, finished: false }; globalThis.__xpanelRemoteCycle = cycle;
    const observer = new MutationObserver(() => {
      const active = Boolean(document.querySelector('button.stop-button'));
      if (active) cycle.started = true;
      if (cycle.started && !active) { cycle.finished = true; observer.disconnect(); }
    });
    observer.observe(document.body, {subtree: true, childList: true});
  })()`);
  await panel.evaluate(clickTextScript("Send"), { userGesture: true });
  // run() sets busy before its first await; observe the execution's state instead
  // of matching a marker that could belong to the previous successful body.
  await waitFor(
    () => panel.evaluate("globalThis.__xpanelRemoteCycle.started"),
    "Remote request start",
  );
  await waitFor(
    () => panel.evaluate("globalThis.__xpanelRemoteCycle.finished"),
    "Remote request finish",
    40_000,
  );
}
export async function result(panel) {
  return panel.evaluate(`({source: document.querySelector('.one-fetch-result')?.getAttribute('data-source'),
    detail: document.querySelector('.one-fetch-result')?.innerText ?? '',
    status: document.querySelector('.response-heading strong')?.innerText ?? '',
    error: document.querySelector('[data-error=true]')?.innerText ?? '',
    meta: document.querySelector('.response-meta')?.innerText ?? ''})`);
}
export async function settle(panel, predicate, label) {
  try {
    return await waitFor(async () => {
      const state = await result(panel);
      return predicate(state) ? state : undefined;
    }, label);
  } catch (error) {
    throw new Error(`${label}: ${JSON.stringify(await result(panel))}`, {
      cause: error,
    });
  }
}
export async function runRemoteResultChecks(panel, origin) {
  for (const status of [201, 302, 404, 503]) {
    await send(panel, `${origin}/status/${status}`);
    await settle(
      panel,
      (s) =>
        s.source === "target" &&
        s.status.startsWith(String(status)) &&
        /Body integrity\s*:\s*Verified\b/u.test(s.detail),
      `verified target ${status}`,
    );
  }
  await panel.evaluate(
    clickTextScript("Headers", "document.querySelector('.response-tabs')"),
  );
  const headers = await waitFor(
    () =>
      panel.evaluate(
        "document.querySelector('.response-content pre')?.innerText",
      ),
    "target response headers",
  );
  invariant(
    (headers.match(/set-cookie:/giu) ?? []).length === 2,
    "Duplicate Set-Cookie values were lost.",
  );
  invariant(
    headers.includes("fixture;dur=2.5"),
    "Target Server-Timing was lost.",
  );
  await panel.evaluate(
    clickTextScript("Timing", "document.querySelector('.response-tabs')"),
  );
  invariant(
    (await result(panel)).detail.includes("fixture"),
    "Target timing is not displayed separately.",
  );

  await send(panel, "http://127.0.0.1:9091/never-contacted");
  await settle(
    panel,
    (s) =>
      s.source === "relay-error" && s.detail.includes("target_not_allowed"),
    "signed policy error",
  );
  await panel.evaluate(clickTextScript("Show last successful response"));
  invariant(
    (await result(panel)).status.startsWith("503"),
    "Relay error overwrote the last target response.",
  );

  await send(panel, `${origin}/partial`);
  await settle(panel, (s) => s.error.length > 0, "partial body rejection");
  invariant(
    (await result(panel)).status.startsWith("503"),
    "Partial response overwrote the last successful response.",
  );

  await send(panel, `${origin}/bytes?size=20971520`);
  await settle(
    panel,
    (s) =>
      s.meta.includes("20971520 B") &&
      /Body integrity\s*:\s*Verified\b/u.test(s.detail),
    "20 MiB body and final digest",
  );
  await send(panel, `${origin}/bytes?size=20971521`);
  await settle(panel, (s) => s.error.length > 0, "20 MiB + 1 rejection");
  invariant(
    (await result(panel)).meta.includes("20971520 B"),
    "Oversized response overwrote the previous body.",
  );

  await setInput(panel, ".url-input", `${origin}/slow`);
  await panel.evaluate(clickTextScript("Send"), { userGesture: true });
  await waitFor(
    () =>
      panel.evaluate(
        "document.querySelector('[role=progressbar]')?.getAttribute('aria-label')?.includes('Downloading')",
      ),
    "Remote download progress",
  );
  const start = performance.now();
  await panel.evaluate(clickTextScript("Stop"), { userGesture: true });
  await settle(
    panel,
    (s) => /cancelled/iu.test(s.error),
    "Remote cancellation",
  );
  const elapsed = performance.now() - start;
  invariant(
    elapsed < 250,
    `Remote Stop acknowledgement exceeded 250 ms: ${elapsed.toFixed(1)}`,
  );
  process.stdout.write(
    `Remote result checks passed: signed targets 201/302/404/503, policy error, duplicate cookies, timing, partial, 20 MiB boundary, Stop (${elapsed.toFixed(1)} ms).\n`,
  );
}
