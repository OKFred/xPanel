import { spawn } from "node:child_process";

import { CdpClient, jsonEndpoint } from "./cdp-client.mjs";
import { availablePort, findChromium } from "./chromium.mjs";
import { waitFor } from "./utils.mjs";

export async function launchUpgradeChromium({
  extensionRoot,
  profileRoot,
  startUrl,
}) {
  const debugPort = await availablePort();
  const executable = await findChromium();
  let stderr = "";
  const processHandle = spawn(
    executable,
    [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-sync",
      "--metrics-recording-only",
      "--host-resolver-rules=MAP * ~NOTFOUND",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileRoot}`,
      `--disable-extensions-except=${extensionRoot}`,
      `--load-extension=${extensionRoot}`,
      "--auto-open-devtools-for-tabs",
      startUrl,
    ],
    { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
  );
  processHandle.stderr.setEncoding("utf8");
  processHandle.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4_096);
  });
  const version = await waitFor(
    () => jsonEndpoint(debugPort, "/json/version"),
    `Chromium debugging endpoint${stderr ? ` (${stderr})` : ""}`,
    30_000,
  );
  const browser = await new CdpClient(version.webSocketDebuggerUrl).open();
  return { browser, debugPort, processHandle };
}

export async function stopUpgradeChromium(session) {
  if (!session) return;
  const exited = new Promise((resolveExit) => {
    if (session.processHandle.exitCode !== null) resolveExit(true);
    else session.processHandle.once("exit", () => resolveExit(true));
  });
  try {
    await session.browser.send("Browser.close");
  } catch {
    // Browser shutdown can close the socket before the acknowledgement.
  }
  session.browser.close();
  const closed = await Promise.race([
    exited,
    new Promise((resolveWait) => setTimeout(() => resolveWait(false), 5_000)),
  ]);
  if (!closed && session.processHandle.exitCode === null) {
    session.processHandle.kill();
    await exited;
  }
}
