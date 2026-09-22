import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const { hooks } = createRequire(import.meta.url)("../.pnpmfile.cjs");
const base = "https://github.com/OKFred/one-fetch/releases/download/v0.1.2/";
const approved = `${base}one-fetch-client-0.1.2.tgz`;
const packageWith = (spec, name = "untrusted", field = "dependencies") => ({
  name,
  [field]: { "@one-fetch/client": spec },
});

test("allows registry ranges and aliases, workspace refs only in own packages", () => {
  for (const spec of [
    "1.2.3",
    "^1.2.3",
    "npm:other@1.2.3",
    "npm:@scope/other@^1.2.3",
  ])
    assert.doesNotThrow(() => hooks.readPackage(packageWith(spec)));
  assert.doesNotThrow(() =>
    hooks.readPackage(packageWith("workspace:*", "@xpanel/extension")),
  );
  assert.throws(
    () => hooks.readPackage(packageWith("workspace:*")),
    /Unapproved/,
  );
});

test("rejects exotic dependencies including aliases and dev/optional/peer fields", () => {
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ])
    for (const spec of [
      "https://example.com/pkg.tgz",
      "github:owner/repo",
      "git+https://example.com/pkg",
      "file:../pkg",
      "npm:other@https://example.com/pkg.tgz",
    ])
      assert.throws(
        () =>
          hooks.readPackage(
            packageWith(
              spec,
              field === "devDependencies" ? "@xpanel/extension" : "untrusted",
              field,
            ),
          ),
        /Unapproved/,
      );
  assert.throws(
    () =>
      hooks.readPackage(
        packageWith(approved.replace("v0.1.2", "v0.1.1"), "@xpanel/extension"),
      ),
    /Unapproved/,
  );
  assert.doesNotThrow(() =>
    hooks.readPackage(packageWith(approved, "@xpanel/extension")),
  );
  assert.throws(() => hooks.readPackage(packageWith(approved)), /Unapproved/);
});

test("pins immutable release resolution and rejects altered integrity or URL", () => {
  const lock = {
    packages: {
      [`@one-fetch/client@${approved}`]: { resolution: { tarball: approved } },
    },
  };
  const resolution =
    hooks.afterAllResolved(lock).packages[`@one-fetch/client@${approved}`]
      .resolution;
  assert.match(resolution.integrity, /^sha512-/);
  resolution.integrity = "sha512-wrong";
  assert.throws(() => hooks.afterAllResolved(lock), /integrity changed/);
  resolution.tarball = "https://example.com/substituted.tgz";
  assert.throws(() => hooks.afterAllResolved(lock), /integrity changed/);
});
