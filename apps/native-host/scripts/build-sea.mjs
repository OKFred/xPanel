import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { inject } from "postject";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const distDirectory = path.join(packageRoot, "dist");
const workDirectory = path.join(distDirectory, ".sea");
const executableDirectory = path.join(
  distDirectory,
  "sea",
  `${process.platform}-${process.arch}`,
);
const executableName =
  process.platform === "win32"
    ? "xpanel-native-host.exe"
    : "xpanel-native-host";
const executablePath = path.join(executableDirectory, executableName);
const bundlePath = path.join(distDirectory, "sea.cjs");
const blobPath = path.join(workDirectory, "xpanel-native-host.blob");
const configPath = path.join(workDirectory, "sea-config.json");

if (Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) < 24) {
  throw new Error(
    "Node.js 24 or newer is required to build the xPanel SEA executable.",
  );
}

execFileSync(process.execPath, [path.join(packageRoot, "scripts/bundle.mjs")], {
  cwd: packageRoot,
  stdio: "inherit",
});

await rm(workDirectory, { recursive: true, force: true });
await mkdir(workDirectory, { recursive: true });
await mkdir(executableDirectory, { recursive: true });
await writeFile(
  configPath,
  `${JSON.stringify(
    {
      main: bundlePath,
      output: blobPath,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

execFileSync(process.execPath, ["--experimental-sea-config", configPath], {
  cwd: packageRoot,
  stdio: "inherit",
});
await copyFile(process.execPath, executablePath);

if (process.platform === "darwin") {
  execFileSync("codesign", ["--remove-signature", executablePath], {
    stdio: "ignore",
  });
}

await inject(executablePath, "NODE_SEA_BLOB", await readFile(blobPath), {
  sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ...(process.platform === "darwin" ? { machoSegmentName: "NODE_SEA" } : {}),
});

if (process.platform === "darwin") {
  execFileSync("codesign", ["--sign", "-", executablePath], {
    stdio: "inherit",
  });
}

const executableHash = createHash("sha256");
for await (const chunk of createReadStream(executablePath)) {
  executableHash.update(chunk);
}
const checksumPath = path.join(executableDirectory, "SHA256SUMS");
await writeFile(
  checksumPath,
  `${executableHash.digest("hex")}  ${executableName}\n`,
  "utf8",
);

process.stderr.write(`Created ${executablePath}\n`);
process.stderr.write(`Created ${checksumPath}\n`);
