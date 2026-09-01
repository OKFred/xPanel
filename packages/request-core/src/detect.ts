import { parse as parseYaml } from "yaml";

import { isRecord } from "./common.js";
import type { ImportFormat } from "./types.js";

export function detectImportFormat(input: string, fileName = ""): ImportFormat {
  const trimmed = input.trim();
  if (/^(?:curl(?:\.exe)?)\s/i.test(trimmed)) return "curl-bash";
  if (/\bInvoke-(?:WebRequest|RestMethod)\b/i.test(trimmed))
    return "powershell";
  if (/\b(?:globalThis\.|window\.)?fetch\s*\(/.test(trimmed))
    return "fetch-node";

  const fromExtension = extensionHint(fileName);
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    try {
      value = parseYaml(trimmed);
    } catch {
      return fromExtension ?? "unknown";
    }
  }
  if (isRecord(value)) {
    if (value.schemaVersion === 1 && Array.isArray(value.requests)) {
      return "xpanel-collection";
    }
    if (isRecord(value.log) && Array.isArray(value.log.entries)) return "har";
    if (value.swagger === "2.0") return "swagger";
    if (typeof value.openapi === "string") return "openapi";
    return fromExtension ?? "json";
  }
  return fromExtension ?? "json";
}

function extensionHint(fileName: string): ImportFormat | undefined {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".har")) return "har";
  if (lower.endsWith(".ps1")) return "powershell";
  if (lower.endsWith(".sh") || lower.endsWith(".bash")) return "curl-bash";
  if (
    lower.endsWith(".mjs") ||
    lower.endsWith(".cjs") ||
    lower.endsWith(".js")
  ) {
    return "fetch-node";
  }
  if (/openapi|swagger/.test(lower) && /\.ya?ml$/.test(lower)) return "openapi";
  return undefined;
}
