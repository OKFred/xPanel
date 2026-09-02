import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sourceRoots = [
  "apps/extension/entrypoints",
  "apps/extension/src",
  "packages/contracts/src",
  "packages/request-core/src",
];
const sourceExtensions = new Set([
  ".cjs",
  ".js",
  ".json",
  ".mjs",
  ".ts",
  ".vue",
]);
const ignoredSegments = new Set([
  ".output",
  "coverage",
  "dist",
  "node_modules",
]);
const forbiddenSourcePatterns = [
  ["eval", /\beval\s*\(/u],
  ["dynamic Function constructor", /\bnew\s+Function\s*\(/u],
  ["remote script element", /<script[^>]+src=["']https?:\/\//iu],
  ["remote dynamic import", /\bimport\s*\(\s*["']https?:\/\//u],
  ["remote importScripts call", /\bimportScripts\s*\(\s*["']https?:\/\//u],
  ["MV2 blocking webRequest", /webRequestBlocking/u],
  ["declarativeNetRequest", /declarativeNetRequest/u],
  ["webRequest interception", /chrome\.webRequest/u],
  ["Native Messaging connection", /\bconnectNative\s*\(/u],
  ["nativeMessaging permission", /["']nativeMessaging["']/u],
];

const failures = [];

function walk(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory)) {
    if (ignoredSegments.has(entry)) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else if (sourceExtensions.has(extname(path))) files.push(path);
  }
  return files;
}

for (const sourceRoot of sourceRoots) {
  for (const file of walk(join(root, sourceRoot))) {
    const source = readFileSync(file, "utf8");
    for (const [label, pattern] of forbiddenSourcePatterns) {
      if (pattern.test(source))
        failures.push(`${relative(root, file)} contains ${label}`);
    }
  }
}

const trackedNames = execFileSync(
  "git",
  ["log", "--all", "--name-only", "--pretty=format:"],
  {
    cwd: root,
    encoding: "utf8",
  },
)
  .split(/\r?\n/u)
  .filter(Boolean);

for (const file of trackedNames) {
  const normalized = file.replaceAll("\\", "/").toLowerCase();
  if (
    normalized.includes("/.sketch/") ||
    normalized.startsWith(".sketch/") ||
    normalized.endsWith(".pem") ||
    normalized.endsWith("/.ds_store") ||
    normalized === ".ds_store"
  ) {
    failures.push(`Git history contains excluded private/local file: ${file}`);
  }
}

const manifestPath = join(
  root,
  "apps/extension/.output/chrome-mv3/manifest.json",
);
if (!existsSync(manifestPath)) {
  failures.push(
    "production MV3 manifest is missing; run the extension build first",
  );
} else {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const requiredPermissions = [...(manifest.permissions ?? [])].sort();
  const optionalPermissions = [...(manifest.optional_permissions ?? [])].sort();
  const optionalHosts = [...(manifest.optional_host_permissions ?? [])].sort();

  if (manifest.manifest_version !== 3)
    failures.push("built manifest is not Manifest V3");
  if (manifest.version !== "2.0.0")
    failures.push("built manifest version is not 2.0.0");
  if (JSON.stringify(requiredPermissions) !== JSON.stringify(["storage"])) {
    failures.push(
      `required permissions are not storage-only: ${requiredPermissions.join(", ")}`,
    );
  }
  if (optionalPermissions.length !== 0) {
    failures.push(
      `optional permissions are unexpected: ${optionalPermissions.join(", ")}`,
    );
  }
  if (
    JSON.stringify(optionalHosts) !==
    JSON.stringify(["http://*/*", "https://*/*"].sort())
  ) {
    failures.push(
      `optional host permissions are unexpected: ${optionalHosts.join(", ")}`,
    );
  }
  if (!manifest.devtools_page)
    failures.push("built manifest has no DevTools entrypoint");

  const serialized = JSON.stringify(manifest);
  for (const forbidden of [
    "webRequest",
    "webRequestBlocking",
    "declarativeNetRequest",
    "nativeMessaging",
  ]) {
    if (serialized.includes(forbidden))
      failures.push(`built manifest contains ${forbidden}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    "Static MV3, permission, remote-code, and Git-history audit passed.",
  );
}
