import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import { invariant } from "./utils.mjs";

export const workspaceRoot = resolve(import.meta.dirname, "..", "..");
const dependencyRoots = [
  "",
  "apps/extension",
  "packages/contracts",
  "packages/request-core",
];

function findPnpmEntryPoint() {
  for (const pathEntry of (process.env.PATH ?? "").split(delimiter)) {
    if (!pathEntry) continue;
    const candidate = join(
      pathEntry,
      "node_modules",
      "pnpm",
      "bin",
      "pnpm.mjs",
    );
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("Could not locate the installed pnpm.mjs entry point.");
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      CI: "1",
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      npm_config_offline: "true",
      pnpm_config_offline: "true",
    },
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed in ${cwd}.\n${result.error ?? ""}\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return result.stdout.trim();
}

export function git(args, cwd = workspaceRoot) {
  return run("git", args, cwd);
}

export function sameValues(actual, expected) {
  return (
    JSON.stringify([...(actual ?? [])].sort()) ===
    JSON.stringify([...(expected ?? [])].sort())
  );
}

export function assertDisposablePath(path, parent, prefix) {
  const resolvedPath = resolve(path);
  invariant(
    dirname(resolvedPath) === resolve(parent) &&
      basename(resolvedPath).startsWith(prefix),
    `Refusing to modify unexpected disposable path: ${resolvedPath}`,
  );
  return resolvedPath;
}

function assertInsideWorktree(path, worktreeRoot) {
  const child = relative(resolve(worktreeRoot), resolve(path));
  invariant(
    child !== "" && !child.startsWith("..") && !isAbsolute(child),
    `Refusing to remove a dependency path outside its worktree: ${path}`,
  );
}

async function linkInstalledDependencies(worktreeRoot) {
  for (const relativeRoot of dependencyRoots) {
    const installed = join(workspaceRoot, relativeRoot, "node_modules");
    invariant(
      existsSync(installed),
      `Installed dependencies are missing at ${installed}.`,
    );
    const target = join(worktreeRoot, relativeRoot, "node_modules");
    await mkdir(dirname(target), { recursive: true });
    if (relativeRoot === "") {
      await symlink(
        installed,
        target,
        process.platform === "win32" ? "junction" : "dir",
      );
    } else {
      await cp(installed, target, {
        recursive: true,
        verbatimSymlinks: true,
      });
    }
  }
}

async function removeInstalledDependencies(worktreeRoot) {
  for (const relativeRoot of [...dependencyRoots].reverse()) {
    const target = join(worktreeRoot, relativeRoot, "node_modules");
    if (!existsSync(target)) continue;
    assertInsideWorktree(target, worktreeRoot);
    if (relativeRoot === "") {
      invariant(
        (await lstat(target)).isSymbolicLink(),
        `Refusing to unlink a non-link dependency root: ${target}`,
      );
      await unlink(target);
    } else {
      await rm(target, { force: true, recursive: true });
    }
  }
}

export async function buildSnapshot(ref, worktreeRoot, label) {
  git(["worktree", "add", "--detach", worktreeRoot, ref]);
  process.stdout.write(`Preparing offline ${label} build...\n`);
  await linkInstalledDependencies(worktreeRoot);
  const pnpmEntryPoint = findPnpmEntryPoint();
  run(process.execPath, [pnpmEntryPoint, "build:extension"], worktreeRoot);
  const extensionRoot = join(
    worktreeRoot,
    "apps",
    "extension",
    ".output",
    "chrome-mv3",
  );
  const manifest = JSON.parse(
    await readFile(join(extensionRoot, "manifest.json"), "utf8"),
  );
  return { extensionRoot, manifest };
}

export async function cleanupUpgradeRoot(temporaryRoot, worktrees) {
  for (const worktree of [...worktrees].reverse()) {
    if (!existsSync(worktree)) continue;
    try {
      await removeInstalledDependencies(worktree);
      git(["worktree", "remove", "--force", worktree]);
    } catch (error) {
      process.stderr.write(`Could not remove temporary worktree: ${error}\n`);
    }
  }
  git(["worktree", "prune"]);
  const disposableRoot = assertDisposablePath(
    temporaryRoot,
    tmpdir(),
    "xpanel-upgrade-e2e-",
  );
  await rm(disposableRoot, { force: true, recursive: true });
  git(["worktree", "prune"]);
}
