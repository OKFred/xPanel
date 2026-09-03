import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createServer as createTcpServer } from "node:net";
import sharp from "sharp";

const workspaceRoot = resolve(import.meta.dirname, "..");
const extensionRoot = join(
  workspaceRoot,
  "apps",
  "extension",
  ".output",
  "chrome-mv3",
);
const manifestPath = join(extensionRoot, "manifest.json");
const remoteBaseUrl = process.env.XPANEL_REMOTE_BASE_URL?.trim();
const remoteToken = process.env.XPANEL_REMOTE_TOKEN?.trim();
const remoteTargetUrl = process.env.XPANEL_REMOTE_TARGET_URL?.trim();
const captureStoreAssets = process.argv.includes("--store-assets");
const storeAssetsRoot = join(
  workspaceRoot,
  "docs",
  "chrome-web-store",
  "assets",
);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function availablePort() {
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

async function findChromium() {
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

function fixtureServer() {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const requestOrigin = request.headers.origin;
    const cors = {
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Origin": requestOrigin ?? "*",
      "Cache-Control": "no-store",
    };
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors);
      response.end();
      return;
    }
    if (url.pathname === "/page") {
      response.writeHead(200, {
        ...cors,
        "Content-Type": "text/html; charset=utf-8",
      });
      response.end(
        "<!doctype html><title>xPanel HAR fixture</title><link rel=icon href=data:,><script>fetch('/captured?via=har').catch(() => {});</script><main>fixture</main>",
      );
      return;
    }
    if (url.pathname === "/captured") {
      response.writeHead(200, {
        ...cors,
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end('{"captured":"har-e2e-ok"}');
      return;
    }
    if (url.pathname === "/stream") {
      const chunks = ['{"source":"browser",', '"result":"browser-e2e-ok"}'];
      const size = chunks.reduce(
        (total, chunk) => total + Buffer.byteLength(chunk),
        0,
      );
      response.writeHead(200, {
        ...cors,
        "Content-Length": String(size),
        "Content-Type": "application/json; charset=utf-8",
      });
      response.write(chunks[0]);
      setTimeout(() => response.end(chunks[1]), 180);
      return;
    }
    if (url.pathname === "/slow") {
      response.writeHead(200, {
        ...cors,
        "Content-Type": "text/plain; charset=utf-8",
      });
      const timeout = setTimeout(() => response.end("too late"), 10_000);
      response.once("close", () => clearTimeout(timeout));
      return;
    }
    response.writeHead(404, {
      ...cors,
      "Content-Type": "text/plain; charset=utf-8",
    });
    response.end("not found");
  });
}

async function listen(server) {
  await new Promise((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveReady);
  });
  const address = server.address();
  invariant(address && typeof address !== "string", "Fixture did not bind.");
  return address.port;
}

class CdpClient {
  #nextId = 0;
  #pending = new Map();

  constructor(url) {
    this.socket = new WebSocket(url);
  }

  async open() {
    await new Promise((resolveOpen, reject) => {
      this.socket.addEventListener("open", resolveOpen, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id !== "number") return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error)
        pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
    this.socket.addEventListener("close", () => {
      for (const pending of this.#pending.values()) {
        pending.reject(new Error("Chrome closed the DevTools connection."));
      }
      this.#pending.clear();
    });
    return this;
  }

  send(method, params = {}) {
    const id = ++this.#nextId;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveResult, reject) => {
      this.#pending.set(id, { resolve: resolveResult, reject });
    });
  }

  async evaluate(expression, { userGesture = false } = {}) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          "Page evaluation failed.",
      );
    }
    return result.result.value;
  }

  close() {
    this.socket.close();
  }
}

async function jsonEndpoint(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  if (!response.ok) throw new Error(`Chrome endpoint ${path} failed.`);
  return response.json();
}

async function waitFor(probe, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(
    `${description} did not become ready.${lastError ? ` ${lastError}` : ""}`,
  );
}

async function targets(port) {
  return jsonEndpoint(port, "/json/list");
}

function inputScript(selector, value) {
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

function clickTextScript(text, scope = "document") {
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

async function setInput(panel, selector, value) {
  const actual = await panel.evaluate(inputScript(selector, value));
  invariant(actual === value, `Could not set ${selector}.`);
}

async function capturePng(client, filePath, width, height) {
  await client.send("Page.enable");
  await client.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  const { data } = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.from(data, "base64"));
}

async function setPanelLanguage(panel, language) {
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

async function fillFirstInputs(panel, values) {
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

async function generatePromoTile() {
  const icon = await readFile(
    join(workspaceRoot, "apps", "extension", "public", "icon", "128.png"),
  );
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="280" viewBox="0 0 440 280">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#08111f"/><stop offset=".55" stop-color="#0f2540"/><stop offset="1" stop-color="#123c5c"/>
      </linearGradient>
      <radialGradient id="glow"><stop stop-color="#38bdf8" stop-opacity=".55"/><stop offset="1" stop-color="#38bdf8" stop-opacity="0"/></radialGradient>
      <filter id="shadow" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="16" stdDeviation="18" flood-color="#020817" flood-opacity=".45"/></filter>
      <clipPath id="shell"><rect x="24" y="27" width="392" height="226" rx="18"/></clipPath>
    </defs>
    <rect width="440" height="280" fill="url(#bg)"/>
    <circle cx="344" cy="50" r="132" fill="url(#glow)" opacity=".75"/>
    <g filter="url(#shadow)">
      <rect x="24" y="27" width="392" height="226" rx="18" fill="#081220" fill-opacity=".9" stroke="#94a3b8" stroke-opacity=".32"/>
      <g clip-path="url(#shell)">
        <rect x="24" y="27" width="112" height="226" fill="#0f233a"/>
        <path d="M136 27v226" stroke="#94a3b8" stroke-opacity=".2"/>
      </g>
    </g>
    <image href="data:image/png;base64,${icon.toString("base64")}" x="41" y="101" width="78" height="78"/>
    <text x="162" y="99" fill="#f8fafc" font-family="Segoe UI,Arial,sans-serif" font-size="42" font-weight="750">xPanel</text>
    <text x="163" y="125" fill="#bae6fd" font-family="Segoe UI,Arial,sans-serif" font-size="12" font-weight="700" letter-spacing="1.6">API CLIENT · DEVTOOLS</text>
    <rect x="162" y="150" width="228" height="38" rx="9" fill="#0b1729" stroke="#7dd3fc" stroke-opacity=".34"/>
    <text x="172" y="174" fill="#67e8f9" font-family="Segoe UI,Arial,sans-serif" font-size="10" font-weight="800">POST</text>
    <rect x="218" y="166" width="89" height="6" rx="3" fill="#64748b"/>
    <rect x="307" y="166" width="39" height="6" rx="3" fill="#334155"/>
    <rect x="350" y="157" width="32" height="24" rx="6" fill="#0ea5e9"/>
    <rect x="162" y="204" width="42" height="5" rx="3" fill="#1e749a"/>
    <rect x="210" y="204" width="68" height="5" rx="3" fill="#155e75"/>
    <rect x="284" y="204" width="31" height="5" rx="3" fill="#0e7490"/>
  </svg>`;
  const output = join(storeAssetsRoot, "global", "small-promo-440x280.png");
  await mkdir(dirname(output), { recursive: true });
  await sharp(Buffer.from(svg)).png().toFile(output);
}

async function generateStoreScreenshots(panel, devtoolsPage, fixtureOrigin) {
  await setPanelLanguage(panel, "en");
  await panel.evaluate(`(() => {
    chrome.permissions.request = async () => true;
    chrome.permissions.contains = async () => true;
  })()`);
  await panel.evaluate(
    `document.querySelector(".sidebar > button.w-full").click()`,
    { userGesture: true },
  );
  await waitFor(
    () =>
      panel.evaluate(
        `document.querySelector('[aria-label="Request URL"]')?.value === ""`,
      ),
    "clean store request",
  );
  await setInput(
    panel,
    '[aria-label="Request URL"]',
    `${fixtureOrigin}/stream`,
  );
  await panel.evaluate(clickTextScript("Send"), { userGesture: true });
  await waitFor(
    () => panel.evaluate(`document.body.innerText.includes("browser-e2e-ok")`),
    "store response",
  );
  await capturePng(
    devtoolsPage,
    join(storeAssetsRoot, "en", "01-api-workbench-1280x800.png"),
    1280,
    800,
  );
  await setPanelLanguage(panel, "zh_CN");
  await capturePng(
    devtoolsPage,
    join(storeAssetsRoot, "zh_CN", "01-api-workbench-1280x800.png"),
    1280,
    800,
  );

  await setPanelLanguage(panel, "en");
  await panel.evaluate(clickTextScript("Import"), { userGesture: true });
  const curlExample = `curl --request POST 'https://api.example.com/v1/orders' \\
  --header 'Accept: application/json' \\
  --header 'Content-Type: application/json' \\
  --data '{"sku":"XP-20","quantity":2}'`;
  await setInput(panel, '[aria-label="Import requests"] textarea', curlExample);
  await waitFor(
    () =>
      panel.evaluate(
        `document.querySelector(".detected-format")?.textContent.includes("curl-bash")`,
      ),
    "cURL detection",
  );
  await capturePng(
    devtoolsPage,
    join(storeAssetsRoot, "en", "02-universal-import-1280x800.png"),
    1280,
    800,
  );
  await setPanelLanguage(panel, "zh_CN");
  await capturePng(
    devtoolsPage,
    join(storeAssetsRoot, "zh_CN", "02-universal-import-1280x800.png"),
    1280,
    800,
  );
  await panel.evaluate(
    clickTextScript(
      "取消",
      `document.querySelector('[aria-label="导入请求"]')`,
    ),
    { userGesture: true },
  );

  await setPanelLanguage(panel, "en");
  await panel.evaluate(
    `document.querySelector(".relay-manage-button").click()`,
    { userGesture: true },
  );
  await waitFor(
    () => panel.evaluate(`Boolean(document.querySelector(".relay-dialog"))`),
    "Relay manager for store screenshot",
  );
  await fillFirstInputs(panel, [
    "Private Cloudflare Relay",
    "https://xpanel-relay.example.workers.dev",
  ]);
  await capturePng(
    devtoolsPage,
    join(storeAssetsRoot, "en", "03-remote-relay-1280x800.png"),
    1280,
    800,
  );
  await setPanelLanguage(panel, "zh_CN");
  await capturePng(
    devtoolsPage,
    join(storeAssetsRoot, "zh_CN", "03-remote-relay-1280x800.png"),
    1280,
    800,
  );
  await panel.evaluate(
    clickTextScript("取消", `document.querySelector(".relay-dialog")`),
    { userGesture: true },
  );
  await setPanelLanguage(panel, "en");
}

async function runLocalizationFlow(panel) {
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

async function runBrowserFlow(panel, fixtureOrigin) {
  const override = await panel.evaluate(`(() => {
    const request = async () => true;
    const contains = async () => true;
    chrome.permissions.request = request;
    chrome.permissions.contains = contains;
    return chrome.permissions.request === request && chrome.permissions.contains === contains;
  })()`);
  invariant(override, "Could not isolate host permission prompts in E2E.");

  await setInput(
    panel,
    '[aria-label="Request URL"]',
    `${fixtureOrigin}/stream`,
  );
  await panel.evaluate(clickTextScript("Send"), { userGesture: true });
  const observedPhases = new Set();
  const responseText = await waitFor(async () => {
    const snapshot = await panel.evaluate(`(() => ({
      phase: document.querySelector("[role=progressbar]")?.getAttribute("aria-label"),
      stop: Boolean(document.querySelector("button.stop-button")),
      text: document.body.innerText,
    }))()`);
    if (snapshot.phase) observedPhases.add(snapshot.phase);
    if (snapshot.stop) observedPhases.add("stop-visible");
    return snapshot.text.includes("browser-e2e-ok") ? snapshot.text : undefined;
  }, "Browser response");
  invariant(
    responseText.includes("200"),
    "Browser response status was not shown.",
  );
  invariant(observedPhases.has("stop-visible"), "Stop did not replace Send.");
  invariant(
    [...observedPhases].some((phase) => /Downloading/i.test(phase)),
    "Browser download progress was not observed.",
  );

  await setInput(panel, '[aria-label="Request URL"]', `${fixtureOrigin}/slow`);
  await panel.evaluate(clickTextScript("Send"), { userGesture: true });
  await waitFor(
    () =>
      panel.evaluate(`Boolean(document.querySelector("button.stop-button"))`),
    "Stop button",
  );
  await panel.evaluate(clickTextScript("Stop"), { userGesture: true });
  const cancelledText = await waitFor(async () => {
    const text = await panel.evaluate("document.body.innerText");
    return /cancelled/i.test(text) ? text : undefined;
  }, "cancelled request");
  invariant(
    cancelledText.includes("browser-e2e-ok"),
    "Cancelling replaced the previous successful response.",
  );

  await panel.evaluate(clickTextScript("Options"), { userGesture: true });
  const timeout = await panel.evaluate(
    `document.querySelector('[aria-label="Timeout (seconds)"]')?.value`,
  );
  invariant(timeout === "60", "New requests do not default to 60 seconds.");
}

async function runHarFlow(panel, inspectedPage) {
  await inspectedPage.send("Page.enable");
  await inspectedPage.send("Page.reload", { ignoreCache: true });
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  await panel.evaluate(clickTextScript("Import"), { userGesture: true });
  await panel.evaluate(clickTextScript("Current Network HAR"), {
    userGesture: true,
  });
  await waitFor(
    () =>
      panel.evaluate(
        `document.querySelector('[aria-label="Import requests"] textarea')?.value.includes("captured?via=har")`,
      ),
    "captured HAR",
  );
  await panel.evaluate(
    clickTextScript(
      "Import",
      `document.querySelector('[aria-label="Import requests"]')`,
    ),
    { userGesture: true },
  );
  const requestCount = await waitFor(async () => {
    const count = await panel.evaluate(
      `document.querySelectorAll(".collection-group .request-link").length`,
    );
    return count >= 2 ? count : undefined;
  }, "imported HAR requests");
  await panel.evaluate(
    `(() => {
    const links = document.querySelectorAll(".collection-group .request-link");
    links[links.length - 1].click();
  })()`,
    { userGesture: true },
  );
  const selectedUrl = await panel.evaluate(
    `document.querySelector('[aria-label="Request URL"]')?.value`,
  );
  invariant(
    typeof selectedUrl === "string" && selectedUrl.includes("127.0.0.1"),
    "An imported sidebar request could not be selected.",
  );
  await panel.evaluate(`setTimeout(() => location.reload(), 0); true`);
  await waitFor(
    () =>
      panel.evaluate(
        `document.querySelectorAll(".collection-group .request-link").length >= ${requestCount}`,
      ),
    "persisted HAR requests",
  );
}

async function runRemoteFlow(panel) {
  if (!remoteBaseUrl && !remoteToken && !remoteTargetUrl) return false;
  invariant(
    remoteBaseUrl && remoteToken && remoteTargetUrl,
    "Remote E2E requires XPANEL_REMOTE_BASE_URL, XPANEL_REMOTE_TOKEN, and XPANEL_REMOTE_TARGET_URL together.",
  );
  await waitFor(
    () =>
      panel.evaluate(
        `Boolean(document.querySelector(".sidebar > button.w-full:not(:disabled)"))`,
      ),
    "new request button",
  );
  await panel.evaluate(
    `document.querySelector(".sidebar > button.w-full").click()`,
    { userGesture: true },
  );
  await waitFor(
    () =>
      panel.evaluate(
        `document.querySelector('[aria-label="Request URL"]')?.value === ""`,
      ),
    "clean Remote request",
  );
  await panel.evaluate(`(() => {
    chrome.permissions.request = async () => true;
    chrome.permissions.contains = async () => true;
  })()`);
  await waitFor(
    () =>
      panel.evaluate(`Boolean(document.querySelector(".relay-manage-button"))`),
    "Relay manager button",
  );
  await panel.evaluate(
    `document.querySelector(".relay-manage-button").click()`,
    { userGesture: true },
  );
  await waitFor(
    () => panel.evaluate(`Boolean(document.querySelector(".relay-dialog"))`),
    "Relay manager",
  );
  const fields = await panel.evaluate(`(() => {
    const fields = document.querySelectorAll(".relay-profile-editor input.field");
    const set = (element, value) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    };
    set(fields[0], "Online acceptance");
    set(fields[1], ${JSON.stringify(remoteBaseUrl)});
    set(fields[2], ${JSON.stringify(remoteToken)});
    return fields.length;
  })()`);
  invariant(fields === 3, "Relay profile fields were not available.");
  await panel.evaluate(
    clickTextScript("Save", `document.querySelector(".relay-dialog")`),
    { userGesture: true },
  );
  await waitFor(
    () =>
      panel.evaluate(
        `document.querySelector(".relay-test-result")?.textContent.includes("Online acceptance")`,
      ),
    "saved Relay profile",
  );
  await panel.evaluate(
    clickTextScript("Cancel", `document.querySelector(".relay-dialog")`),
    { userGesture: true },
  );
  const profileId = await panel.evaluate(`(() => {
    const select = document.querySelector("select.executor-select");
    const option = [...select.options].find((entry) => entry.textContent.includes("Online acceptance"));
    if (!option) throw new Error("Saved Relay profile is missing.");
    select.value = option.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return option.value;
  })()`);
  invariant(profileId !== "browser", "Remote profile was not selectable.");
  await setInput(panel, '[aria-label="Request URL"]', remoteTargetUrl);
  await panel.evaluate(clickTextScript("Send"), { userGesture: true });
  const consent = await waitFor(
    () =>
      panel.evaluate(
        `document.querySelector('[role="alertdialog"]')?.innerText`,
      ),
    "Remote disclosure",
  );
  invariant(
    consent.includes(new URL(remoteTargetUrl).origin) &&
      consent.includes(new URL(remoteBaseUrl).host),
    "Remote disclosure omitted the target or Relay host.",
  );
  await panel.evaluate(
    `(() => {
      const dialog = document.querySelector('[role="alertdialog"]');
      const button = [...dialog.querySelectorAll("button")].find((entry) => entry.classList.contains("primary-button"));
      if (!button) throw new Error("Missing Remote confirmation button.");
      button.click();
    })()`,
    { userGesture: true },
  );
  let text;
  try {
    text = await waitFor(
      async () => {
        const content = await panel.evaluate("document.body.innerText");
        return content.includes("remote-e2e-ok") ? content : undefined;
      },
      "Remote Relay response",
      30_000,
    );
  } catch (error) {
    const snapshot = await panel.evaluate(
      `document.body.innerText.slice(-4000)`,
    );
    throw new Error(`Remote UI snapshot:\n${snapshot}`, { cause: error });
  }
  invariant(
    text.includes("Remote"),
    "Remote executor was not shown on response.",
  );
  return true;
}

let browserClient;
let devtoolsClient;
let panelClient;
let inspectedClient;
let chromeProcess;
let profileRoot;
const fixture = fixtureServer();

try {
  invariant(existsSync(manifestPath), "Build the MV3 extension before E2E.");
  const fixturePort = await listen(fixture);
  const fixtureOrigin = `http://127.0.0.1:${fixturePort}`;
  const inspectedStartUrl =
    "data:text/html,%3Ctitle%3ExPanel-E2E%3C%2Ftitle%3Efixture";
  const debugPort = await availablePort();
  const executable = await findChromium();
  profileRoot = await mkdtemp(join(tmpdir(), "xpanel-chromium-e2e-"));
  if (captureStoreAssets) {
    const defaultProfile = join(profileRoot, "Default");
    await mkdir(defaultProfile, { recursive: true });
    await writeFile(
      join(defaultProfile, "Preferences"),
      JSON.stringify({
        devtools: {
          preferences: {
            currentDockState: '"undocked"',
            lastDockState: '"right"',
          },
        },
      }),
    );
  }
  let stderr = "";
  chromeProcess = spawn(
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
      ...(captureStoreAssets ? ["--window-size=1280,800"] : []),
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileRoot}`,
      `--disable-extensions-except=${extensionRoot}`,
      `--load-extension=${extensionRoot}`,
      "--auto-open-devtools-for-tabs",
      inspectedStartUrl,
    ],
    { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
  );
  chromeProcess.stderr.setEncoding("utf8");
  chromeProcess.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4_096);
  });

  const version = await waitFor(
    () => jsonEndpoint(debugPort, "/json/version"),
    `Chromium debugging endpoint${stderr ? ` (${stderr})` : ""}`,
  );
  browserClient = await new CdpClient(version.webSocketDebuggerUrl).open();
  const initialTargets = await waitFor(async () => {
    const entries = await targets(debugPort);
    const devtools = entries.find(
      (entry) => entry.type === "page" && entry.url.startsWith("devtools://"),
    );
    const inspected = entries.find(
      (entry) => entry.type === "page" && entry.url === inspectedStartUrl,
    );
    return devtools && inspected ? { devtools, inspected } : undefined;
  }, "DevTools and inspected page");
  devtoolsClient = await new CdpClient(
    initialTargets.devtools.webSocketDebuggerUrl,
  ).open();
  inspectedClient = await new CdpClient(
    initialTargets.inspected.webSocketDebuggerUrl,
  ).open();
  await inspectedClient.send("Page.enable");

  const panelKey = await waitFor(
    () =>
      devtoolsClient.evaluate(
        `Object.keys(UI.panels).find((key) => key.endsWith("xPanel"))`,
      ),
    "xPanel DevTools registration",
  );
  await devtoolsClient.evaluate(
    `InspectorFrontendAPI.showPanel(${JSON.stringify(panelKey)})`,
  );
  const panelTarget = await waitFor(async () => {
    const entries = await targets(debugPort);
    return entries.find(
      (entry) =>
        entry.type === "iframe" && entry.url.includes("devtools-panel.html"),
    );
  }, "xPanel DevTools panel");
  panelClient = await new CdpClient(panelTarget.webSocketDebuggerUrl).open();
  await waitFor(
    () =>
      panelClient.evaluate(
        `document.querySelector('.url-input')?.value === ""`,
      ),
    "xPanel workbench",
  );

  await runLocalizationFlow(panelClient);

  await inspectedClient.send("Page.navigate", { url: `${fixtureOrigin}/page` });
  await waitFor(
    () =>
      inspectedClient.evaluate(
        `location.href === ${JSON.stringify(`${fixtureOrigin}/page`)}`,
      ),
    "fixture page navigation",
  );

  await runBrowserFlow(panelClient, fixtureOrigin);
  await runHarFlow(panelClient, inspectedClient);
  const remoteChecked = await runRemoteFlow(panelClient);
  if (captureStoreAssets) {
    await generateStoreScreenshots(panelClient, devtoolsClient, fixtureOrigin);
    await generatePromoTile();
  }

  process.stdout.write(
    `Chromium MV3 E2E passed: DevTools panel, bilingual UI, Browser streaming/cancel, HAR import/select/persist${remoteChecked ? ", Remote Relay" : ""}${captureStoreAssets ? ", store assets" : ""}.\n`,
  );
} finally {
  await new Promise((resolveClosed) => fixture.close(resolveClosed));
  panelClient?.close();
  inspectedClient?.close();
  devtoolsClient?.close();
  if (browserClient) {
    try {
      await browserClient.send("Browser.close");
    } catch {
      // Closing the browser can close the socket before the acknowledgement.
    }
    browserClient.close();
  }
  if (chromeProcess && chromeProcess.exitCode === null) chromeProcess.kill();
  if (profileRoot) {
    const resolvedProfile = resolve(profileRoot);
    const resolvedTemp = resolve(tmpdir());
    invariant(
      dirname(resolvedProfile) === resolvedTemp &&
        basename(resolvedProfile).startsWith("xpanel-chromium-e2e-"),
      "Refusing to remove an unexpected Chromium profile path.",
    );
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await rm(resolvedProfile, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 3) {
          process.stderr.write(
            `Could not remove the disposable Chromium profile: ${String(error)}\n`,
          );
          process.exitCode = 1;
          break;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
    }
  }
}
