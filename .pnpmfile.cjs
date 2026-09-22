// Scoped replacement for pnpm 11's all-or-nothing blockExoticSubdeps setting.
// No downloaded manifest may introduce an arbitrary URL/git/file dependency.
/* global module */
const base = "https://github.com/OKFred/one-fetch/releases/download/v0.1.2/";
const approved = new Map(
  ["client", "core", "protocol"].map((name) => [
    `@one-fetch/${name}`,
    `${base}one-fetch-${name}-0.1.2.tgz`,
  ]),
);

function readPackage(pkg) {
  const workspacePackage =
    pkg.name === "xpanel" || pkg.name?.startsWith("@xpanel/");
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    // Published dev dependencies are not installed (and may self-link file:.).
    ...(workspacePackage ? ["devDependencies"] : []),
  ]) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      const registry = /^[a-zA-Z0-9_.*~^<>=| +-]+$/u.test(spec);
      const alias =
        /^npm:(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@[a-zA-Z0-9_.*~^<>=| +-]+$/u.test(
          spec,
        );
      if (registry || alias) continue;
      if (
        spec.startsWith("workspace:") &&
        (pkg.name === "xpanel" || pkg.name?.startsWith("@xpanel/"))
      )
        continue;
      if (
        approved.get(name) === spec &&
        (pkg.name?.startsWith("@xpanel/") || approved.has(pkg.name))
      )
        continue;
      throw new Error(`Unapproved dependency source in ${pkg.name}: ${name}`);
    }
  }
  return pkg;
}

const integrity = {
  client:
    "sha512-z6eKiMYbWvBicqYDWTI8yCl1y5J7bafkrKXrRf6KS9B/22p6EsEJxfrvwfgoU2YyfGe3L4uHPaw7FLNxVc5ZUg==",
  protocol:
    "sha512-45tWYI45fauNIraI01Wov1NbJwZJN4Dm+RSC4OcQQXGG2MFSPE33vaVVjoJ8hUdmjNg/zaTZIjwP88dfJjdKIw==",
  core: "sha512-c/mGPFk6CuAncLAVBDE355AOcm3LdWcXB4KmW9hy3/SEecCS6jwquuXNyolZhzk0KZYvNUE5KgEKkPenA31dAQ==",
};

function afterAllResolved(lockfile) {
  for (const [key, entry] of Object.entries(lockfile.packages ?? {})) {
    for (const [name, url] of approved) {
      if (key !== `${name}@${url}`) continue;
      const expected = integrity[name.split("/")[1]];
      if (
        entry.resolution?.tarball !== url ||
        (entry.resolution.integrity && entry.resolution.integrity !== expected)
      ) {
        throw new Error(`one-fetch release integrity changed: ${name}`);
      }
      entry.resolution.integrity = expected;
    }
  }
  return lockfile;
}

module.exports = { hooks: { readPackage, afterAllResolved } };
