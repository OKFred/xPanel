import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import sharp from "sharp";

const workspaceRoot = resolve(import.meta.dirname, "..");
const assetsRoot = join(workspaceRoot, "docs", "chrome-web-store", "assets");

async function assertImage(relativePath, width, height) {
  const path = join(assetsRoot, relativePath);
  const metadata = await sharp(path).metadata();
  if (
    metadata.format !== "png" ||
    metadata.width !== width ||
    metadata.height !== height
  ) {
    throw new Error(
      `${relativePath} must be a ${width}x${height} PNG; received ${metadata.width}x${metadata.height} ${metadata.format}.`,
    );
  }
}

const screenshotNames = [
  "01-api-workbench-1280x800.png",
  "02-universal-import-1280x800.png",
  "03-remote-relay-1280x800.png",
];

for (const locale of ["en", "zh_CN"]) {
  const actual = (await readdir(join(assetsRoot, locale))).sort();
  if (JSON.stringify(actual) !== JSON.stringify(screenshotNames)) {
    throw new Error(
      `${locale} screenshots differ from the reviewed three-file set: ${actual.join(", ")}.`,
    );
  }
  for (const name of screenshotNames) {
    await assertImage(join(locale, name), 1280, 800);
  }
}

await assertImage(join("global", "store-icon-128.png"), 128, 128);
await assertImage(join("global", "small-promo-440x280.png"), 440, 280);
await assertImage(
  join("..", "..", "..", "apps", "extension", "public", "icon", "128.png"),
  128,
  128,
);

process.stdout.write(
  "Chrome Web Store assets verified: 6 localized screenshots, store icon, and small promo tile.\n",
);
