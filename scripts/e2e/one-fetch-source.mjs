import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { invariant } from "./utils.mjs";

const execute = promisify(execFile);
const published = {
  commit: "056380ecbfc48cedea82096a86196a29261395b4",
  version: "0.1.2",
};

/** Candidate probes must name an exact clean commit; normal E2E stays Release-only. */
export async function verifyOneFetchSource(root, review) {
  const git = async (args) =>
    (
      await execute("git", args, { cwd: root, windowsHide: true })
    ).stdout.trim();
  const commit = review ? review.commit : published.commit;
  invariant(
    /^[a-f0-9]{40}$/u.test(commit),
    "A full reviewed source commit is required.",
  );
  invariant(
    (await git(["rev-parse", "HEAD"])) === commit,
    "one-fetch checkout does not match the reviewed commit.",
  );
  invariant(
    !(await git(["status", "--porcelain"])),
    "Refusing to deploy a modified one-fetch checkout.",
  );
  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  invariant(
    /^\d+\.\d+\.\d+$/u.test(manifest.version),
    "Invalid one-fetch build version.",
  );
  if (!review) {
    invariant(
      manifest.version === published.version &&
        (await git(["rev-parse", `v${published.version}^{commit}`])) === commit,
      "Normal acceptance requires the pinned published Release.",
    );
  }
  return {
    commit,
    version: manifest.version,
    sourceKind: review ? "review-candidate" : "published-release",
  };
}
