import {
  spawn,
  type ChildProcessByStdio,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import type { Readable } from "node:stream";
import type { CurlProcessResult, PreparedCurlRequest } from "./curl.js";
import { sanitizedCurlEnvironment } from "./curl.js";
import { NativeHostError } from "./errors.js";

const MAX_DIAGNOSTIC_BYTES = 256 * 1024;

function appendBounded(
  chunks: Buffer[],
  chunk: Buffer,
  currentSize: number,
): number {
  if (currentSize >= MAX_DIAGNOSTIC_BYTES) {
    return currentSize;
  }
  const remaining = MAX_DIAGNOSTIC_BYTES - currentSize;
  const accepted =
    chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
  chunks.push(accepted);
  return currentSize + accepted.byteLength;
}

export class ManagedProcess {
  readonly #child: ChildProcessByStdio<null, Readable, Readable>;
  readonly #completion: Promise<CurlProcessResult>;
  #cancelled = false;
  #killTimer: NodeJS.Timeout | undefined;

  public constructor(
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio = {},
  ) {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    this.#child = spawn(command, [...args], {
      ...options,
      env: options.env ?? sanitizedCurlEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = appendBounded(stdout, chunk, stdoutBytes);
    });
    this.#child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = appendBounded(stderr, chunk, stderrBytes);
    });

    this.#completion = new Promise((resolve, reject) => {
      this.#child.once("error", (error) => {
        this.#clearKillTimer();
        reject(
          new NativeHostError(
            "CURL_FAILED",
            `Unable to start curl: ${error.message}`,
            {
              cause: error,
              retryable: true,
            },
          ),
        );
      });
      this.#child.once("close", (exitCode, signal) => {
        this.#clearKillTimer();
        resolve({
          exitCode,
          signal,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          cancelled: this.#cancelled,
        });
      });
    });
  }

  public get completion(): Promise<CurlProcessResult> {
    return this.#completion;
  }

  public cancel(): boolean {
    if (
      this.#child.exitCode !== null ||
      this.#child.signalCode !== null ||
      this.#cancelled
    ) {
      return false;
    }
    this.#cancelled = true;
    this.#child.kill("SIGTERM");
    this.#killTimer = setTimeout(() => {
      if (this.#child.exitCode === null && this.#child.signalCode === null) {
        this.#child.kill("SIGKILL");
      }
    }, 2_000);
    this.#killTimer.unref();
    return true;
  }

  #clearKillTimer(): void {
    if (this.#killTimer !== undefined) {
      clearTimeout(this.#killTimer);
      this.#killTimer = undefined;
    }
  }
}

export function executeCurl(prepared: PreparedCurlRequest): ManagedProcess {
  return new ManagedProcess(
    process.platform === "win32" ? "curl.exe" : "curl",
    prepared.args,
  );
}
