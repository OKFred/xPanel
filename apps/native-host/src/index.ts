#!/usr/bin/env node
import { diagnose } from "./diagnostics.js";

async function main(): Promise<void> {
  if (process.argv[2] === "diagnose") {
    const report = await diagnose();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (process.argv.length > 2) {
    process.stderr.write("Usage: xpanel-native-host [diagnose]\n");
    process.exitCode = 2;
    return;
  }
  const { runNativeHost } = await import("./host.js");
  await runNativeHost(process.stdin, process.stdout);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `xPanel native host failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
