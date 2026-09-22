import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
let input = "";
for await (const chunk of process.stdin) {
  input += String(chunk);
  assert(input.length <= 4 * 1024 * 1024, "SBOM input exceeds 4 MiB.");
}
const sbom = JSON.parse(input);
assert(sbom.bomFormat === "CycloneDX" && sbom.specVersion === "1.6");
const manifest = JSON.parse(
  await readFile(resolve(root, "apps/extension/package.json"), "utf8"),
);
assert.equal(sbom.metadata.component.version, manifest.version);
for (const name of ["client", "core", "protocol"]) {
  const component = sbom.components.find(
    (item) => item.group === "@one-fetch" && item.name === name,
  );
  assert.equal(
    component?.version,
    "0.1.2",
    `Missing pinned one-fetch ${name}.`,
  );
  const reference = component.externalReferences?.find(
    (item) => item.type === "distribution",
  );
  assert.equal(
    reference?.url,
    `https://github.com/OKFred/one-fetch/releases/download/v0.1.2/one-fetch-${name}-0.1.2.tgz`,
  );
  assert(
    reference.hashes.some(
      (hash) => hash.alg === "SHA-512" && /^[a-f0-9]{128}$/u.test(hash.content),
    ),
  );
}
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const lockHash = createHash("sha256")
  .update(await readFile(resolve(root, "pnpm-lock.yaml")))
  .digest("hex");
sbom.metadata.properties = [
  { name: "xpanel:commit", value: commit },
  { name: "xpanel:lockfile-sha256", value: lockHash },
  {
    name: "xpanel:inventory",
    value:
      "Production dependency graph before bundling/tree-shaking; not a claim every module is emitted.",
  },
];
const output = resolve(root, "apps/extension/.output");
await mkdir(output, { recursive: true });
await writeFile(
  resolve(output, "sbom.cdx.json"),
  `${JSON.stringify(sbom, null, 2)}\n`,
);
process.stdout.write(
  `CycloneDX SBOM recorded: ${sbom.components.length} components, immutable one-fetch distributions and SHA-512.\n`,
);
