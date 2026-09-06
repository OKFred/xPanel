import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { invariant } from "./utils.mjs";

export async function availablePort() {
  const server = createTcpServer();
  await new Promise((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveReady);
  });
  const address = server.address();
  invariant(
    address && typeof address !== "string",
    "Could not reserve a port.",
  );
  const port = address.port;
  await new Promise((resolveClosed) => server.close(resolveClosed));
  return port;
}

async function playwrightChromiumCandidates() {
  const root = join(homedir(), "AppData", "Local", "ms-playwright");
  if (!existsSync(root)) return [];
  const directories = (await readdir(root, { withFileTypes: true }))
    .filter(
      (entry) => entry.isDirectory() && /^chromium-\d+$/u.test(entry.name),
    )
    .sort((left, right) =>
      right.name.localeCompare(left.name, undefined, { numeric: true }),
    );
  return directories.flatMap((entry) => [
    join(root, entry.name, "chrome-win64", "chrome.exe"),
    join(root, entry.name, "chrome-win", "chrome.exe"),
  ]);
}

export async function findChromium() {
  const explicit = process.env.XPANEL_CHROMIUM_EXECUTABLE?.trim();
  const candidates = [
    ...(explicit ? [resolve(explicit)] : []),
    ...(process.platform === "win32"
      ? await playwrightChromiumCandidates()
      : process.platform === "darwin"
        ? [
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
          ]
        : [
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/google-chrome-for-testing",
          ]),
  ];
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) {
    throw new Error(
      "No extension-capable Chromium was found. Set XPANEL_CHROMIUM_EXECUTABLE to Chromium or Chrome for Testing.",
    );
  }
  return executable;
}
