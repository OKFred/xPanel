// Scoped replacement for pnpm 11's all-or-nothing blockExoticSubdeps setting.
// No downloaded manifest may introduce an arbitrary URL/git/file dependency.
/* global module */
const base = "https://github.com/OKFred/one-fetch/releases/download/v0.1.1/";
const approved = new Map(
  ["client", "core", "protocol"].map((name) => [
    `@one-fetch/${name}`,
    `${base}one-fetch-${name}-0.1.1.tgz`,
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
    "sha512-MgruitV82ehl6oC6vNL1IbN7daZPQfG1inItr2JQ9IwBs0rzGDloKY1O8xRgP4Nt07+Aa8khHvd9+86YPqOBGA==",
  protocol:
    "sha512-nAnynTp0I5y7CRor0aPHAeOLF29hBHoYqJKvUuUGWKspwy+ybTO6lDe5eqUijmIuIQJr1DWdsP31DoFUDOGTPQ==",
  core: "sha512-CBikVSbbiINdDJIiH+r2NmqalA9OwXxhjcUESao1ZJ/pOC7pJa/vwc9/mMKcDEFcKDs2fNPGLmuBoL7SWva0FA==",
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
