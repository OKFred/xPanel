import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { invariant } from "./utils.mjs";

// Stdin avoids Docker Desktop's read-only rootfs copy limitations. Files are
// created by the non-root container user and atomically exposed after EOF.
export async function copyContainerInput(id, source, target) {
  invariant(/^[a-f0-9]{64}$/u.test(id), "Invalid container identity.");
  invariant(
    /^\/tmp\/(?:entry\.mjs|one-fetch\.tar\.gz)$/u.test(target),
    "Invalid staging target.",
  );
  const bytes = await readFile(source);
  invariant(bytes.length <= 32 * 1024 * 1024, "Staging input is too large.");
  const script =
    "const fs=require('node:fs'),c=require('node:crypto');(async()=>{const p=process.argv[1];await require('node:stream/promises').pipeline(process.stdin,fs.createWriteStream(p+'.pending',{flags:'wx',mode:0o600}));const b=fs.readFileSync(p+'.pending');fs.renameSync(p+'.pending',p);process.stdout.write(c.createHash('sha256').update(b).digest('hex'))})().catch(()=>{process.exitCode=1})";
  const child = spawn(
    "docker",
    ["exec", "--interactive", id, "node", "-e", script, target],
    {
      windowsHide: true,
      timeout: 60_000,
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (text) => {
    output += text;
    if (output.length > 256) child.kill();
  });
  await new Promise((accept, reject) => {
    const fail = () => {
      child.kill();
      reject(new Error("Container input staging failed."));
    };
    child.once("error", fail);
    child.stdin.once("error", fail);
    child.once("close", (code) => (code === 0 ? accept() : fail()));
    child.stdin.end(bytes);
  });
  invariant(
    output === createHash("sha256").update(bytes).digest("hex"),
    "Container input digest mismatch.",
  );
}
