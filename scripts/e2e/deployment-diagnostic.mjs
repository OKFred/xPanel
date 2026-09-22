import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Child-process failures are useful, but environment files, DB passwords and
// service keys must never be copied into stdout or public acceptance receipts.
export async function deploymentDiagnostic(error, directory) {
  // Keep the end of each stream: verbose successful tests on stderr must not
  // displace the actual deployment error emitted on stdout.
  const streams = [String(error?.stdout ?? ""), String(error?.stderr ?? "")];
  const env = await readFile(join(directory, "deployment.env"), "utf8").catch(
    () => "",
  );
  const values = env
    .split(/\r?\n/u)
    .map((line) => line.slice(line.indexOf("=") + 1));
  for (const file of ["database-password", "service-role-key"])
    values.push(await readFile(join(directory, file), "utf8").catch(() => ""));
  const sanitized = streams.map((stream, index) => {
    let text = stream;
    for (const value of values
      .map((v) => v.trim())
      .filter((v) => v.length >= 12))
      text = text
        .replaceAll(value, "[REDACTED]")
        .replaceAll(encodeURIComponent(value), "[REDACTED]");
    // Redact before truncation so a secret across the cut cannot leak a suffix.
    return text
      .replace(/(?:postgres(?:ql)?:\/\/)[^\s]+/giu, "[REDACTED DATABASE URL]")
      .replace(
        /\b(?:sbp_[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/gu,
        "[REDACTED TOKEN]",
      )
      .replace(/Bearer\s+[^\s"']+/giu, "Bearer [REDACTED]")
      .slice(index === 0 ? -6000 : -3000);
  });
  return `stdout:\n${sanitized[0]}\nstderr:\n${sanitized[1]}`;
}
