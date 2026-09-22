// Scoped replacement for pnpm 11's all-or-nothing blockExoticSubdeps setting.
// No downloaded manifest may introduce an arbitrary URL/git/file dependency.
const base = "https://github.com/OKFred/one-fetch/releases/download/v0.1.1/";
const approved = new Map(
  ["client", "core", "protocol"].map((name) => [
    `@one-fetch/${name}`,
    `${base}one-fetch-${name}-0.1.1.tgz`,
  ]),
);

function readPackage(pkg) {
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      const registry =
        /^(?:npm:)?(?:[@a-zA-Z0-9_.*~^<>=| +\-]+(?:\/[a-zA-Z0-9_.\-]+)?@)?[a-zA-Z0-9_.*~^<>=| +\-]+$/u.test(
          spec,
        ) && !spec.includes("/");
      if (registry || spec.startsWith("npm:")) continue;
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

module.exports = { hooks: { readPackage } };
