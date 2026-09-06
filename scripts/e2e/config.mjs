import { join, resolve } from "node:path";

export const workspaceRoot = resolve(import.meta.dirname, "..", "..");
export const extensionRoot = join(
  workspaceRoot,
  "apps",
  "extension",
  ".output",
  "chrome-mv3",
);
export const manifestPath = join(extensionRoot, "manifest.json");
export const storeAssetsRoot = join(
  workspaceRoot,
  "docs",
  "chrome-web-store",
  "assets",
);

export const e2eConfig = {
  workspaceRoot,
  extensionRoot,
  manifestPath,
  storeAssetsRoot,
  remoteBaseUrl: process.env.XPANEL_REMOTE_BASE_URL?.trim(),
  remoteToken: process.env.XPANEL_REMOTE_TOKEN?.trim(),
  remoteTargetUrl: process.env.XPANEL_REMOTE_TARGET_URL?.trim(),
  captureStoreAssets: process.argv.includes("--store-assets"),
};
