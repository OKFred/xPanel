import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "..");
const baselinePath = join(
  workspaceRoot,
  "scripts/fixtures/extension-update-baseline-2.0.json",
);
const manifestPath = process.env.XPANEL_UPGRADE_MANIFEST_PATH
  ? resolve(process.env.XPANEL_UPGRADE_MANIFEST_PATH)
  : join(workspaceRoot, "apps/extension/.output/chrome-mv3/manifest.json");

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sortedUnique(values, label) {
  const sorted = [...(values ?? [])].sort();
  invariant(
    new Set(sorted).size === sorted.length,
    `${label} contains duplicate entries.`,
  );
  return sorted;
}

function difference(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function workspacePackagePaths() {
  const paths = ["package.json"];
  for (const root of ["apps", "packages"]) {
    for (const entry of await readdir(join(workspaceRoot, root), {
      withFileTypes: true,
    })) {
      if (entry.isDirectory()) paths.push(`${root}/${entry.name}/package.json`);
    }
  }
  return paths;
}

const baseline = await readJson(baselinePath);
const targetVersion = baseline.targetVersion;
const expectedAddedPermissions = sortedUnique(
  baseline.expectedAddedWarninglessPermissions,
  "Reviewed permission additions",
);
const warninglessPermissionsReviewedForThisUpdate = new Set(
  baseline.reviewedWarninglessPermissions,
);
const manifest = await readJson(manifestPath).catch((error) => {
  throw new Error(
    "The production extension manifest is missing or invalid; run the extension build first.",
    { cause: error },
  );
});
const packages = await Promise.all(
  (await workspacePackagePaths()).map(async (path) => ({
    path,
    value: await readJson(join(workspaceRoot, path)),
  })),
);

invariant(baseline.schemaVersion === 1, "Unknown update baseline schema.");
invariant(
  typeof baseline.chromiumBaselineVersion === "string" &&
    /^[\da-f]{40}$/u.test(baseline.chromiumBaselineCommit),
  "The audited Chromium update baseline is missing its immutable commit/version.",
);
for (const entry of packages) {
  invariant(
    entry.value.version === targetVersion,
    `${entry.path} is ${entry.value.version ?? "unversioned"}; expected ${targetVersion}.`,
  );
}
invariant(
  manifest.manifest_version === 3,
  "The built extension is not Manifest V3.",
);
invariant(
  manifest.version === targetVersion,
  `Built Manifest version is ${manifest.version ?? "missing"}; expected ${targetVersion}.`,
);
invariant(
  manifest.version === packages[1].value.version,
  "Extension package and built Manifest versions differ.",
);

const previousRequired = sortedUnique(
  baseline.requiredPermissions,
  "Baseline required permissions",
);
const currentRequired = sortedUnique(
  manifest.permissions,
  "Current required permissions",
);
const addedRequired = difference(currentRequired, previousRequired);
const removedRequired = difference(previousRequired, currentRequired);

invariant(
  JSON.stringify(addedRequired) === JSON.stringify(expectedAddedPermissions),
  `Unexpected required-permission delta: added [${addedRequired.join(", ")}].`,
);
invariant(
  removedRequired.length === 0,
  `Unexpected required-permission delta: removed [${removedRequired.join(", ")}].`,
);
invariant(
  addedRequired.every((permission) =>
    warninglessPermissionsReviewedForThisUpdate.has(permission),
  ),
  "The update adds a required permission that was not reviewed as warningless.",
);

const previousOptional = sortedUnique(
  baseline.optionalPermissions,
  "Baseline optional permissions",
);
const currentOptional = sortedUnique(
  manifest.optional_permissions,
  "Current optional permissions",
);
const previousOptionalHosts = sortedUnique(
  baseline.optionalHostPermissions,
  "Baseline optional host permissions",
);
const currentOptionalHosts = sortedUnique(
  manifest.optional_host_permissions,
  "Current optional host permissions",
);

invariant(
  JSON.stringify(currentOptional) === JSON.stringify(previousOptional),
  "Optional API permissions changed from the reviewed 2.0.x baseline.",
);
invariant(
  JSON.stringify(currentOptionalHosts) ===
    JSON.stringify(previousOptionalHosts),
  "Optional host permissions changed from the reviewed 2.0.x baseline.",
);
invariant(
  sortedUnique(manifest.host_permissions, "Current required host permissions")
    .length === 0,
  "The update introduces required host access.",
);
invariant(
  !manifest.content_scripts,
  "The update introduces declarative content-script access.",
);

const baselineDisplay = previousRequired.join(", ");
const currentDisplay = currentRequired.join(", ");
process.stdout.write(
  `Extension update regression passed: ${baseline.releaseLine} [${baselineDisplay}] -> ${manifest.version} [${currentDisplay}].\n` +
    `Reviewed warningless additions: ${addedRequired.join(", ")}. Package and Manifest versions are coherent.\n`,
);
process.stdout.write(
  `Baseline: ${relative(workspaceRoot, baselinePath).replaceAll("\\", "/")}\n`,
);
