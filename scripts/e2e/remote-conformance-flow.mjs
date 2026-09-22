import { send, settle, result } from "./remote-result-checks.mjs";
import { clickTextScript, setInput } from "./panel-actions.mjs";
import { invariant, waitFor } from "./utils.mjs";

export async function runRemoteConformanceFlow(
  panel,
  origin,
  integrity = "verified",
) {
  const verified = (s) =>
    s.source === "target" &&
    (integrity === "verified"
      ? /Body integrity\s*:\s*Verified\b/u.test(s.detail)
      : /Body integrity\s*:\s*Not verified\b/u.test(s.detail) &&
        s.detail.includes("report-digest-unavailable"));
  // The deployed synthetic Worker only implements these fixtures; it is not a
  // relay and accepts no credentials other than explicit synthetic test values.
  for (const code of [201, 302, 404, 503]) {
    await send(panel, `${origin}/status/${code}`);
    await settle(
      panel,
      (s) => verified(s) && s.status.startsWith(String(code)),
      `cloud signed target ${code}`,
    );
  }
  await send(panel, `${origin}/set-cookie`);
  await settle(panel, verified, "cloud cookie integrity");
  await panel.evaluate(
    clickTextScript("Headers", "document.querySelector('.response-tabs')"),
  );
  invariant(
    await panel.evaluate(
      "(document.querySelector('.response-content pre')?.innerText.match(/set-cookie:/gi) ?? []).length === 2",
    ),
    "Cloud duplicate Set-Cookie was lost.",
  );
  await send(panel, `${origin}/server-timing`);
  await panel.evaluate(
    clickTextScript("Timing", "document.querySelector('.response-tabs')"),
  );
  await settle(
    panel,
    (s) => verified(s) && s.detail.includes("database"),
    "cloud target Server-Timing",
  );
  await send(
    panel,
    `${origin}/redirect?to=${encodeURIComponent("/echo?duplicate=one&duplicate=two")}`,
  );
  await settle(panel, verified, "cloud redirect");
  await send(panel, `${origin}/bytes/20971520`);
  await settle(
    panel,
    (s) => verified(s) && s.meta.includes("20971520 B"),
    "cloud 20 MiB digest",
  );
  await send(panel, `${origin}/bytes/20971521`);
  await settle(panel, (s) => s.error.length > 0, "cloud 20 MiB + 1 rejection");
  if ((await result(panel)).source !== "target")
    await panel.evaluate(clickTextScript("Show last successful response"));
  invariant(
    (await result(panel)).meta.includes("20971520 B"),
    "Cloud oversize replaced the previous result.",
  );
  await send(panel, `${origin}/truncated`);
  await settle(panel, (s) => s.error.length > 0, "cloud partial rejection");
  await setInput(panel, ".url-input", `${origin}/delay/12000`);
  await panel.evaluate(clickTextScript("Send"), { userGesture: true });
  await waitFor(
    () =>
      panel.evaluate(
        "document.querySelector('[role=progressbar]')?.getAttribute('aria-label')?.includes('Waiting')",
      ),
    "cloud waiting progress",
  );
  await panel.evaluate(clickTextScript("Stop"), { userGesture: true });
  await settle(panel, (s) => /cancelled/iu.test(s.error), "cloud cancellation");
  process.stdout.write(
    "Cloud Chromium conformance passed: signed 2xx/3xx/4xx/5xx, duplicate cookies, Server-Timing, redirects, 20 MiB boundary, partial, Stop.\n",
  );
}
