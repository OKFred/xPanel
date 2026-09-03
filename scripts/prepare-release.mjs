import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

import { unzipSync } from "fflate";
import sharp from "sharp";

const workspaceRoot = resolve(import.meta.dirname, "..");
const extensionRoot = join(workspaceRoot, "apps", "extension");
const outputRoot = join(extensionRoot, ".output");
const artifactRoot = join(workspaceRoot, "artifacts", "chrome-web-store");
const manifest = JSON.parse(
  await readFile(join(outputRoot, "chrome-mv3", "manifest.json"), "utf8"),
);

function git(...args) {
  return execFileSync("git", args, {
    cwd: workspaceRoot,
    encoding: "utf8",
  }).trim();
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

const status = git("status", "--porcelain", "--untracked-files=all");
invariant(!status, `Release preparation requires a clean worktree:\n${status}`);
const branch = git("branch", "--show-current");
invariant(
  branch === "codex/refactor-mv3-devpanel",
  `Refusing to prepare a store package from ${branch}.`,
);
const commit = git("rev-parse", "HEAD");
const upstreamCommit = git("rev-parse", "@{upstream}");
invariant(commit === upstreamCommit, "The release commit has not been pushed.");
invariant(manifest.manifest_version === 3, "The extension is not Manifest V3.");
invariant(manifest.version === "2.0.0", "The extension version is not 2.0.0.");
invariant(
  JSON.stringify(manifest.permissions) === JSON.stringify(["storage"]),
  "Required permissions changed after review.",
);
invariant(
  JSON.stringify(manifest.optional_host_permissions) ===
    JSON.stringify(["http://*/*", "https://*/*"]),
  "Optional host permissions changed after review.",
);

const zipFiles = (await readdir(outputRoot)).filter((name) =>
  name.endsWith("-chrome.zip"),
);
invariant(zipFiles.length === 1, "Expected exactly one Chrome release ZIP.");
const sourceZip = join(outputRoot, zipFiles[0]);
const packageName = basename(sourceZip);
const packageHash = await sha256(sourceZip);
const packageSize = (await stat(sourceZip)).size;
const zipEntries = unzipSync(new Uint8Array(await readFile(sourceZip)));
const zipEntryNames = Object.keys(zipEntries);
invariant(
  zipEntryNames.length > 0 && zipEntries["manifest.json"],
  "The extension ZIP does not contain a root manifest.json.",
);
invariant(
  !zipEntryNames.some(
    (name) =>
      name.startsWith("/") ||
      name.includes("../") ||
      /(^|\/)(\.sketch|node_modules)(\/|$)/u.test(name) ||
      /\.(pem|key|p12|pfx)$/iu.test(name),
  ),
  "The extension ZIP contains an unsafe or excluded path.",
);
const zippedManifest = JSON.parse(
  Buffer.from(zipEntries["manifest.json"]).toString("utf8"),
);
invariant(
  zippedManifest.manifest_version === manifest.manifest_version &&
    zippedManifest.version === manifest.version,
  "The packaged manifest differs from the reviewed build output.",
);

invariant(
  dirname(artifactRoot) === join(workspaceRoot, "artifacts") &&
    basename(artifactRoot) === "chrome-web-store",
  "Refusing to replace an unexpected artifact directory.",
);
await rm(artifactRoot, { recursive: true, force: true });
await mkdir(artifactRoot, { recursive: true });
await copyFile(sourceZip, join(artifactRoot, packageName));
await cp(
  join(workspaceRoot, "docs", "chrome-web-store"),
  join(artifactRoot, "submission-kit"),
  { recursive: true, force: true },
);
await copyFile(
  join(workspaceRoot, "docs", "privacy.md"),
  join(artifactRoot, "privacy.md"),
);
await writeFile(
  join(artifactRoot, "SHA256SUMS"),
  `${packageHash}  ${packageName}\n`,
  "utf8",
);

const assetsRoot = join(workspaceRoot, "docs", "chrome-web-store", "assets");
const assetPaths = [];
for (const locale of ["en", "zh_CN", "global"]) {
  for (const name of (await readdir(join(assetsRoot, locale))).sort()) {
    assetPaths.push(join(assetsRoot, locale, name));
  }
}
const assets = [];
for (const path of assetPaths) {
  const metadata = await sharp(path).metadata();
  assets.push({
    path: relative(workspaceRoot, path).replaceAll("\\", "/"),
    sha256: await sha256(path),
    width: metadata.width,
    height: metadata.height,
    bytes: (await stat(path)).size,
  });
}

await writeFile(
  join(artifactRoot, "release-manifest.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      itemId: "diaemdialoooebdennhpgnmobnjabohm",
      version: manifest.version,
      manifestVersion: manifest.manifest_version,
      branch,
      commit,
      package: {
        name: packageName,
        sha256: packageHash,
        bytes: packageSize,
        entries: zipEntryNames.length,
      },
      privacyPolicy:
        "https://github.com/OKFred/xPanel/blob/codex/refactor-mv3-devpanel/docs/privacy.md",
      assets,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

process.stdout.write(
  `Prepared ${relative(workspaceRoot, artifactRoot)} at ${commit.slice(0, 7)} (${packageHash}).\n`,
);
