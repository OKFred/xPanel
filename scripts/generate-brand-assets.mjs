import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import sharp from "sharp";

const workspaceRoot = resolve(import.meta.dirname, "..");
const extensionIcon = join(
  workspaceRoot,
  "apps",
  "extension",
  "public",
  "icon",
  "128.png",
);
const storeIcon = join(
  workspaceRoot,
  "docs",
  "chrome-web-store",
  "assets",
  "global",
  "store-icon-128.png",
);

const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="brand" x1="22" y1="18" x2="108" y2="112" gradientUnits="userSpaceOnUse">
      <stop stop-color="#60a5fa"/>
      <stop offset=".48" stop-color="#3b82f6"/>
      <stop offset="1" stop-color="#2563eb"/>
    </linearGradient>
  </defs>
  <rect x="16" y="16" width="96" height="96" rx="24" fill="url(#brand)"/>
  <path d="M43 43L85 85M85 43L43 85" fill="none" stroke="#fff" stroke-width="12" stroke-linecap="round"/>
  <circle cx="94" cy="34" r="5" fill="#a5f3fc"/>
</svg>`;

await Promise.all(
  [extensionIcon, storeIcon].map(async (output) => {
    await mkdir(dirname(output), { recursive: true });
    await sharp(Buffer.from(iconSvg)).png().toFile(output);
  }),
);

process.stdout.write(
  "Generated the 128x128 xPanel extension and store icons.\n",
);
