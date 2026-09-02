import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const token = randomBytes(32).toString("base64url");
const digest = createHash("sha256").update(token, "utf8").digest("hex");

function copyToClipboard(value) {
  const candidates =
    process.platform === "win32"
      ? [["clip.exe", []]]
      : process.platform === "darwin"
        ? [["pbcopy", []]]
        : [
            ["wl-copy", []],
            ["xclip", ["-selection", "clipboard"]],
          ];

  for (const [command, args] of candidates) {
    const result = spawnSync(command, args, {
      input: value,
      encoding: "utf8",
      stdio: ["pipe", "ignore", "ignore"],
    });
    if (result.status === 0) return true;
  }
  return false;
}

const copied = copyToClipboard(token);
process.stdout.write(`RELAY_TOKEN_SHA256=${digest}\n`);
process.stdout.write(
  copied
    ? "The plaintext bearer token is in your clipboard. It was not printed or written to disk.\n"
    : "Clipboard access was unavailable. No plaintext token was printed or written; run the command again after installing a clipboard helper.\n",
);
process.stdout.write(
  "Store only the digest above as the Worker secret. Store the plaintext token only in an xPanel Relay profile.\n",
);
