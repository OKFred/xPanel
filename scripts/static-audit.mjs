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
const expectedRequiredPermissions = ["alarms", "offscreen", "storage"];
const expectedOptionalHosts = ["http://*/*", "https://*/*"];
const expectedExtensionVersion = "3.0.1";
const expectedHomepageUrl = "https://github.com/okfred";
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
  [
    "legacy Relay transport",
    /["'](?:X-XPanel-(?:Request|Response)|\/v1\/execute)["']/iu,
  ],
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

for (const [locale, standaloneMarker] of [
  ["en", "standalone"],
  ["zh_CN", "独立"],
]) {
  const messagesPath = join(
    root,
    "apps/extension/public/_locales",
    locale,
    "messages.json",
  );
  const messages = JSON.parse(readFileSync(messagesPath, "utf8"));
  const description = messages.extensionDescription?.message;
  if (
    typeof description !== "string" ||
    !description.includes(standaloneMarker) ||
    !description.includes("DevTools")
  ) {
    failures.push(`${locale} extension description omits a workbench surface`);
  }
}

// The retired Relay is recoverable from Git, but must never ship or build.
for (const retired of [
  "apps/relay-cloudflare/package.json",
  "apps/extension/src/lib/remote-profiles.ts",
  "apps/extension/src/lib/execution/remote-protocol.ts",
]) {
  if (existsSync(join(root, retired)))
    failures.push(`Retired Relay implementation remains: ${retired}`);
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

const extensionOutputRoot = join(root, "apps/extension/.output/chrome-mv3");
const manifestPath = join(extensionOutputRoot, "manifest.json");
if (!existsSync(manifestPath)) {
  failures.push(
    "production MV3 manifest is missing; run the extension build first",
  );
} else {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const extensionPackage = JSON.parse(
    readFileSync(join(root, "apps/extension/package.json"), "utf8"),
  );
  const requiredPermissions = [...(manifest.permissions ?? [])].sort();
  const optionalPermissions = [...(manifest.optional_permissions ?? [])].sort();
  const optionalHosts = [...(manifest.optional_host_permissions ?? [])].sort();

  if (manifest.manifest_version !== 3)
    failures.push("built manifest is not Manifest V3");
  if (manifest.version !== expectedExtensionVersion) {
    failures.push(`built manifest version is not ${expectedExtensionVersion}`);
  }
  if (extensionPackage.version !== manifest.version) {
    failures.push("extension package and built manifest versions do not match");
  }
  if (manifest.homepage_url !== expectedHomepageUrl) {
    failures.push("built manifest homepage URL is unexpected");
  }
  if (
    JSON.stringify(requiredPermissions) !==
    JSON.stringify(expectedRequiredPermissions)
  ) {
    failures.push(
      `required permissions are unexpected: ${requiredPermissions.join(", ")}`,
    );
  }
  if (optionalPermissions.length !== 0) {
    failures.push(
      `optional permissions are unexpected: ${optionalPermissions.join(", ")}`,
    );
  }
  if (JSON.stringify(optionalHosts) !== JSON.stringify(expectedOptionalHosts)) {
    failures.push(
      `optional host permissions are unexpected: ${optionalHosts.join(", ")}`,
    );
  }
  if (!manifest.devtools_page)
    failures.push("built manifest has no DevTools entrypoint");
  const backgroundScript = manifest.background?.service_worker;
  if (!backgroundScript) {
    failures.push("built manifest has no background service worker");
  } else if (!existsSync(join(extensionOutputRoot, backgroundScript))) {
    failures.push(
      "production MV3 build is missing its background service worker",
    );
  }
  for (const [file, label] of [
    ["offscreen.html", "offscreen execution document"],
    ["workbench.html", "standalone workbench"],
    ["execution-processor.js", "streaming response processor worker"],
    ["response-document.js", "virtual response viewer worker"],
  ]) {
    if (!existsSync(join(extensionOutputRoot, file))) {
      failures.push(`production MV3 build has no ${label}`);
    }
  }

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
    "Static MV3, background-execution, permission, remote-code, and Git-history audit passed.",
  );
}
