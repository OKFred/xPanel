import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const workspaceRoot = resolve(import.meta.dirname, "..");
const verifierPath = join(
  workspaceRoot,
  "scripts/verify-extension-upgrade.mjs",
);
const builtManifestPath = join(
  workspaceRoot,
  "apps/extension/.output/chrome-mv3/manifest.json",
);

test("rejects an added warning-producing required permission", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "xpanel-upgrade-"));
  const manifestPath = join(temporaryRoot, "manifest.json");

  try {
    const manifest = JSON.parse(await readFile(builtManifestPath, "utf8"));
    manifest.permissions = [...(manifest.permissions ?? []), "tabs"];
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    const result = spawnSync(process.execPath, [verifierPath], {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        XPANEL_UPGRADE_MANIFEST_PATH: manifestPath,
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unexpected required-permission delta/u);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});
