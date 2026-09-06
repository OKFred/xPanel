import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import sharp from "sharp";

import { capturePng } from "./cdp-client.mjs";
import {
  clickTextScript,
  fillFirstInputs,
  setInput,
  setPanelLanguage,
} from "./panel-actions.mjs";
import { waitFor } from "./utils.mjs";

export async function generatePromoTile({ workspaceRoot, storeAssetsRoot }) {
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

export async function generateStoreScreenshots(
  workbench,
  fixtureOrigin,
  storeAssetsRoot,
) {
  await setPanelLanguage(workbench, "en");
  await workbench.evaluate(`(() => {
    chrome.permissions.request = async () => true;
    chrome.permissions.contains = async () => true;
  })()`);
  await workbench.evaluate(
    `document.querySelector(".sidebar > button.w-full").click()`,
    { userGesture: true },
  );
  await waitFor(
    () =>
      workbench.evaluate(
        `document.querySelector('[aria-label="Request URL"]')?.value === ""`,
      ),
    "clean store request",
  );
  await setInput(
    workbench,
    '[aria-label="Request URL"]',
    `${fixtureOrigin}/stream`,
  );
  await workbench.evaluate(clickTextScript("Send"), { userGesture: true });
  await waitFor(
    () =>
      workbench.evaluate(`document.body.innerText.includes("browser-e2e-ok")`),
    "store response",
  );
  await capturePng(
    workbench,
    join(storeAssetsRoot, "en", "01-api-workbench-1280x800.png"),
    1280,
    800,
  );
  await setPanelLanguage(workbench, "zh_CN");
  await capturePng(
    workbench,
    join(storeAssetsRoot, "zh_CN", "01-api-workbench-1280x800.png"),
    1280,
    800,
  );

  await setPanelLanguage(workbench, "en");
  await workbench.evaluate(clickTextScript("Import"), { userGesture: true });
  const curlExample = `curl --request POST 'https://api.example.com/v1/orders' \\
  --header 'Accept: application/json' \\
  --header 'Content-Type: application/json' \\
  --data '{"sku":"XP-20","quantity":2}'`;
  await setInput(
    workbench,
    '[aria-label="Import requests"] textarea',
    curlExample,
  );
  await waitFor(
    () =>
      workbench.evaluate(
        `document.querySelector(".detected-format")?.textContent.includes("curl-bash")`,
      ),
    "cURL detection",
  );
  await capturePng(
    workbench,
    join(storeAssetsRoot, "en", "02-universal-import-1280x800.png"),
    1280,
    800,
  );
  await setPanelLanguage(workbench, "zh_CN");
  await capturePng(
    workbench,
    join(storeAssetsRoot, "zh_CN", "02-universal-import-1280x800.png"),
    1280,
    800,
  );
  await workbench.evaluate(
    clickTextScript(
      "取消",
      `document.querySelector('[aria-label="导入请求"]')`,
    ),
    { userGesture: true },
  );

  await setPanelLanguage(workbench, "en");
  await workbench.evaluate(
    `document.querySelector(".relay-manage-button").click()`,
    {
      userGesture: true,
    },
  );
  await waitFor(
    () =>
      workbench.evaluate(`Boolean(document.querySelector(".relay-dialog"))`),
    "Relay manager for store screenshot",
  );
  await fillFirstInputs(workbench, [
    "Private Cloudflare Relay",
    "https://xpanel-relay.example.workers.dev",
  ]);
  await capturePng(
    workbench,
    join(storeAssetsRoot, "en", "03-remote-relay-1280x800.png"),
    1280,
    800,
  );
  await setPanelLanguage(workbench, "zh_CN");
  await capturePng(
    workbench,
    join(storeAssetsRoot, "zh_CN", "03-remote-relay-1280x800.png"),
    1280,
    800,
  );
  await workbench.evaluate(
    clickTextScript("取消", `document.querySelector(".relay-dialog")`),
    { userGesture: true },
  );
  await setPanelLanguage(workbench, "en");
}
