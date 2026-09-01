import { spawnSync } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { constants as fsConstants } from "node:fs";
import { HOST_NAME, HOST_VERSION } from "./constants.js";
import { sanitizedCurlEnvironment } from "./curl.js";

export interface DiagnosticReport {
  ok: boolean;
  host: string;
  hostVersion: string;
  node: string;
  platform: string;
  architecture: string;
  curl: { ok: boolean; version?: string; error?: string };
  temporaryFiles: { ok: boolean; error?: string };
}

function curlVersionSupported(versionLine: string): boolean {
  const match = /^curl\s+(\d+)\.(\d+)(?:\.\d+)?/.exec(versionLine);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 7 || (major === 7 && minor >= 70);
}

export async function diagnose(): Promise<DiagnosticReport> {
  const curlCommand = process.platform === "win32" ? "curl.exe" : "curl";
  const curlResult = spawnSync(curlCommand, ["--disable", "--version"], {
    encoding: "utf8",
    env: sanitizedCurlEnvironment(),
    shell: false,
    windowsHide: true,
  });
  const versionLine = curlResult.stdout.split(/\r?\n/, 1)[0] ?? "unknown";
  const curl =
    curlResult.status === 0 && curlVersionSupported(versionLine)
      ? { ok: true, version: versionLine }
      : {
          ok: false,
          error:
            curlResult.status === 0
              ? `curl 7.70.0 or newer is required; found: ${versionLine}`
              : (curlResult.error?.message ??
                (curlResult.stderr.trim() || "curl is unavailable.")),
        };

  let temporaryFiles: DiagnosticReport["temporaryFiles"] = { ok: true };
  let directory: string | undefined;
  try {
    directory = await mkdtemp(path.join(os.tmpdir(), "xpanel-diagnose-"));
    const probe = path.join(directory, "probe");
    await writeFile(probe, "ok", { mode: 0o600 });
    await access(probe, fsConstants.R_OK | fsConstants.W_OK);
  } catch (error) {
    temporaryFiles = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (
      directory !== undefined &&
      path.basename(directory).startsWith("xpanel-diagnose-")
    ) {
      await rm(directory, { recursive: true, force: true });
    }
  }

  return {
    ok: curl.ok && temporaryFiles.ok,
    host: HOST_NAME,
    hostVersion: HOST_VERSION,
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    curl,
    temporaryFiles,
  };
}
