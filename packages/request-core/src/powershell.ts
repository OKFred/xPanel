import type {
  FileReferenceV1,
  ImportWarning,
  KeyValueItem,
  MultipartPart,
  RequestSpecV1,
} from "@xpanel/contracts";

import {
  detectBody,
  extractStructuredAuth,
  makeRequest,
  materializeAuth,
  prepareRequestForExport,
  normalizeMethod,
  powerShellSingleQuote,
  requestBodyText,
  requestUrl,
  safeId,
  splitUrlQuery,
  warning,
} from "./common.js";
import type { RequestParseResult } from "./curl.js";

interface PowerShellToken {
  value: string;
  quoted: boolean;
}

export function parsePowerShell(input: string): RequestParseResult {
  const warnings: ImportWarning[] = [];
  if (/\$\(|`[^\r\n]/.test(input)) {
    warnings.push(
      warning(
        "powershell.dynamic_expression",
        "PowerShell subexpressions and command substitutions are never evaluated.",
      ),
    );
  }
  if (/(^|[^|])\|([^|]|$)/m.test(input)) {
    warnings.push(
      warning(
        "powershell.pipeline_ignored",
        "PowerShell pipelines are ignored.",
      ),
    );
  }

  const assignments = extractStaticAssignments(input, warnings);
  const commands = findPowerShellCommands(input);
  if (commands.length === 0) {
    return {
      requests: [],
      warnings: [
        ...warnings,
        warning(
          "powershell.command_missing",
          "No Invoke-WebRequest or Invoke-RestMethod command was found.",
        ),
      ],
    };
  }

  const requests: RequestSpecV1[] = [];
  for (const [commandIndex, command] of commands.entries()) {
    const tokens = tokenizePowerShell(command, warnings);
    const commandToken = tokens.findIndex((token) =>
      /^Invoke-(?:WebRequest|RestMethod)$/i.test(token.value),
    );
    if (commandToken < 0) continue;
    let rawUrl: string | undefined;
    let method: string | undefined;
    let bodyText: string | undefined;
    let timeoutMs: number | undefined;
    let rawBodyFile: FileReferenceV1 | undefined;
    let proxyUrl: string | undefined;
    const headers: KeyValueItem[] = [];
    let multipart: MultipartPart[] | undefined;

    for (let index = commandToken + 1; index < tokens.length; index += 1) {
      const token = tokens[index]?.value;
      const valueToken = tokens[index + 1];
      if (!token?.startsWith("-")) {
        if (!rawUrl && tokens[index]?.quoted) rawUrl = token;
        continue;
      }
      const name = token.toLowerCase();
      if (
        name === "-usebasicparsing" ||
        name === "-skipcertificatecheck" ||
        name === "-maximumredirection"
      ) {
        if (name === "-skipcertificatecheck") {
          warnings.push(
            warning(
              "powershell.tls_insecure",
              "TLS verification was disabled by the imported command.",
            ),
          );
        }
        continue;
      }
      if (!valueToken || valueToken.value.startsWith("-")) continue;
      index += 1;
      const resolved = resolveStaticValue(valueToken, assignments, warnings);
      switch (name) {
        case "-uri":
          rawUrl = resolved;
          break;
        case "-method":
          method = resolved ? normalizeMethod(resolved) : undefined;
          break;
        case "-headers": {
          const raw = valueToken.value.startsWith("$")
            ? assignments.get(valueToken.value.slice(1).toLowerCase())
            : valueToken.value;
          if (raw?.trimStart().startsWith("@{")) {
            headers.push(...parseHashtable(raw, warnings));
          } else {
            warnings.push(
              warning(
                "powershell.headers_dynamic",
                "Only a static PowerShell hashtable can be imported as headers.",
              ),
            );
          }
          break;
        }
        case "-contenttype":
          if (resolved) {
            headers.push({
              name: "Content-Type",
              value: resolved,
              enabled: true,
            });
          }
          break;
        case "-body":
          bodyText = resolved;
          break;
        case "-infile":
          if (resolved) {
            rawBodyFile = fileFromPath(resolved);
            warnings.push(
              warning(
                "powershell.file_reselection_required",
                `File ${resolved} was not read and must be selected again.`,
              ),
            );
          }
          break;
        case "-form": {
          const raw = valueToken.value.startsWith("$")
            ? assignments.get(valueToken.value.slice(1).toLowerCase())
            : valueToken.value;
          if (raw?.trimStart().startsWith("@{")) {
            multipart = parseFormHashtable(raw, warnings);
          } else {
            warnings.push(
              warning(
                "powershell.form_dynamic",
                "Only a static PowerShell form hashtable can be imported.",
              ),
            );
          }
          break;
        }
        case "-timeoutsec": {
          const seconds = Number(resolved);
          if (Number.isFinite(seconds) && seconds > 0)
            timeoutMs = seconds * 1000;
          break;
        }
        case "-proxy":
          proxyUrl = resolved;
          break;
        case "-proxycredential":
        case "-certificate":
        case "-certificatethumbprint":
          warnings.push(
            warning(
              "powershell.native_option_requires_confirmation",
              `${token} requires confirmation in Native mode.`,
            ),
          );
          break;
        default:
          warnings.push(
            warning(
              "powershell.parameter_unsupported",
              `Unsupported PowerShell parameter: ${token}`,
            ),
          );
      }
    }

    if (!rawUrl) {
      warnings.push(
        warning(
          "powershell.url_missing",
          `PowerShell command ${commandIndex + 1} has no static URI.`,
        ),
      );
      continue;
    }
    const split = splitUrlQuery(rawUrl);
    const extracted = extractStructuredAuth(headers, split.query);
    const body = multipart
      ? ({ kind: "multipart", parts: multipart } as const)
      : rawBodyFile
        ? ({ kind: "file", file: rawBodyFile } as const)
        : detectBody(bodyText, headers);
    const request = makeRequest(
      { format: "powershell" },
      {
        name: `Imported PowerShell ${commandIndex + 1}`,
        method: method ?? (body.kind === "none" ? "GET" : "POST"),
        url: split.url,
        query: extracted.query,
        headers: extracted.headers,
        auth: extracted.auth,
        body,
        options: {
          redirect: "follow",
          cookieMode: "include",
          timeoutMs: timeoutMs ?? 30_000,
          proxy: proxyUrl ? { url: proxyUrl, bypass: [] } : null,
          tls: { verify: !/-SkipCertificateCheck\b/i.test(command) },
        },
        warnings,
      },
    );
    requests.push(request);
  }
  return { requests, warnings };
}

export function exportPowerShell(
  input: RequestSpecV1,
  options: { includeSensitive?: boolean } = {},
): { text: string; warnings: ImportWarning[] } {
  const prepared = prepareRequestForExport(input, options.includeSensitive);
  const request = materializeAuth(prepared.request);
  const warnings: ImportWarning[] = [...prepared.warnings];
  const lines = [
    "Invoke-WebRequest",
    `  -Uri ${powerShellSingleQuote(requestUrl(request))}`,
    `  -Method ${powerShellSingleQuote(request.method)}`,
  ];
  const headers = request.headers.filter((item) => item.enabled !== false);
  if (headers.length) {
    const entries = headers
      .map(
        (header) =>
          `${powerShellSingleQuote(header.name)} = ${powerShellSingleQuote(header.value)}`,
      )
      .join("; ");
    lines.push(`  -Headers @{ ${entries} }`);
  }
  if (request.options.timeoutMs > 0) {
    lines.push(`  -TimeoutSec ${Math.ceil(request.options.timeoutMs / 1000)}`);
  }
  if (!request.options.tls.verify) lines.push("  -SkipCertificateCheck");
  if (request.options.proxy) {
    lines.push(`  -Proxy ${powerShellSingleQuote(request.options.proxy.url)}`);
  }
  if (request.body.kind === "multipart") {
    const entries = request.body.parts
      .filter((part) => part.enabled !== false)
      .map((part) => {
        if (part.kind === "text") {
          return `${powerShellSingleQuote(part.name)} = ${powerShellSingleQuote(part.value)}`;
        }
        const path = part.file.pathHint ?? part.file.name;
        warnings.push(
          warning(
            "export.file_path_hint",
            `Exported ${path} as a path hint; the receiver must reselect it.`,
          ),
        );
        return `${powerShellSingleQuote(part.name)} = Get-Item ${powerShellSingleQuote(path)}`;
      })
      .join("; ");
    lines.push(`  -Form @{ ${entries} }`);
  } else if (request.body.kind === "file") {
    const path = request.body.file.pathHint ?? request.body.file.name;
    lines.push(`  -InFile ${powerShellSingleQuote(path)}`);
    warnings.push(
      warning(
        "export.file_path_hint",
        `Exported ${path} as a path hint; the receiver must reselect it.`,
      ),
    );
  } else {
    const body = requestBodyText(request);
    if (body !== undefined)
      lines.push(`  -Body ${powerShellSingleQuote(body)}`);
  }
  return { text: lines.join(" `\n"), warnings };
}

function fileFromPath(pathHint: string): FileReferenceV1 {
  return {
    id: safeId("body"),
    name: pathHint.split(/[\\/]/).at(-1) || "body.bin",
    pathHint,
    requiresReselection: true,
  };
}

function findPowerShellCommands(input: string): string[] {
  const normalized = input.replace(/`\r?\n/g, " ");
  const pattern = /\bInvoke-(?:WebRequest|RestMethod)\b/gi;
  const starts: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(normalized)) !== null) starts.push(match.index);
  return starts.map((start, index) =>
    normalized.slice(start, starts[index + 1] ?? normalized.length).trim(),
  );
}

function tokenizePowerShell(
  input: string,
  warnings: ImportWarning[],
): PowerShellToken[] {
  const tokens: PowerShellToken[] = [];
  let index = 0;
  while (index < input.length) {
    while (/\s/.test(input[index] ?? "")) index += 1;
    if (index >= input.length) break;
    if (input.startsWith("@{", index)) {
      const end = findBalancedHashtableEnd(input, index);
      tokens.push({ value: input.slice(index, end), quoted: false });
      index = end;
      continue;
    }
    const quote = input[index];
    if (quote === "'" || quote === '"') {
      const parsed = readPowerShellString(input, index, warnings);
      tokens.push({ value: parsed.value, quoted: true });
      index = parsed.end;
      continue;
    }
    const start = index;
    while (index < input.length && !/\s/.test(input[index] ?? "")) index += 1;
    tokens.push({
      value: input.slice(start, index).replace(/[;,]$/, ""),
      quoted: false,
    });
  }
  return tokens;
}

function readPowerShellString(
  input: string,
  start: number,
  warnings: ImportWarning[],
): { value: string; end: number } {
  const quote = input[start];
  let value = "";
  let index = start + 1;
  while (index < input.length) {
    const char = input[index];
    if (char === quote) {
      if (input[index + 1] === quote) {
        value += quote;
        index += 2;
        continue;
      }
      return { value, end: index + 1 };
    }
    if (quote === '"' && char === "$") {
      warnings.push(
        warning(
          "powershell.interpolation_not_evaluated",
          "PowerShell string interpolation was preserved as text.",
        ),
      );
    }
    if (quote === '"' && char === "`" && index + 1 < input.length) {
      const escaped = input[index + 1];
      value += escaped === "n" ? "\n" : escaped === "r" ? "\r" : escaped;
      index += 2;
      continue;
    }
    value += char;
    index += 1;
  }
  warnings.push(
    warning("powershell.quote_unclosed", "Unclosed PowerShell quote."),
  );
  return { value, end: input.length };
}

function findBalancedHashtableEnd(input: string, start: number): number {
  let depth = 0;
  let quote: string | undefined;
  for (let index = start; index < input.length; index += 1) {
    const char = input[index];
    if (quote) {
      if (char === quote && input[index + 1] === quote) index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return index + 1;
  }
  return input.length;
}

function extractStaticAssignments(
  input: string,
  warnings: ImportWarning[],
): Map<string, string> {
  const values = new Map<string, string>();
  const hashtablePattern = /\$([A-Za-z_][\w-]*)\s*=\s*@\{/g;
  let match: RegExpExecArray | null;
  while ((match = hashtablePattern.exec(input)) !== null) {
    const name = match[1];
    if (!name) continue;
    const start = input.indexOf("@{", match.index);
    const end = findBalancedHashtableEnd(input, start);
    values.set(name.toLowerCase(), input.slice(start, end));
    hashtablePattern.lastIndex = end;
  }
  const stringPattern =
    /\$([A-Za-z_][\w-]*)\s*=\s*('(?:''|[^'])*'|"(?:`.|[^"])*")/g;
  while ((match = stringPattern.exec(input)) !== null) {
    const name = match[1];
    const literal = match[2];
    if (!name || !literal) continue;
    const parsed = readPowerShellString(literal, 0, warnings);
    values.set(name.toLowerCase(), parsed.value);
  }
  return values;
}

function resolveStaticValue(
  token: PowerShellToken,
  assignments: Map<string, string>,
  warnings: ImportWarning[],
): string | undefined {
  if (token.value.startsWith("$")) {
    const result = assignments.get(token.value.slice(1).toLowerCase());
    if (result === undefined) {
      warnings.push(
        warning(
          "powershell.variable_unresolved",
          `Variable ${token.value} has no supported static assignment.`,
        ),
      );
    }
    return result;
  }
  if (!token.quoted && /[(){}]/.test(token.value)) {
    warnings.push(
      warning(
        "powershell.expression_unsupported",
        `Expression ${token.value} was not evaluated.`,
      ),
    );
    return undefined;
  }
  return token.value;
}

function parseHashtable(
  raw: string,
  warnings: ImportWarning[],
): KeyValueItem[] {
  return parseHashtablePairs(raw, warnings).flatMap(([name, value]) =>
    value.kind === "literal"
      ? [{ name, value: value.value, enabled: true }]
      : [],
  );
}

function parseFormHashtable(
  raw: string,
  warnings: ImportWarning[],
): MultipartPart[] {
  return parseHashtablePairs(raw, warnings).map(([name, value]) => {
    if (value.kind === "file") {
      return {
        kind: "file",
        name,
        enabled: true,
        file: {
          id: safeId("file"),
          name: value.value.split(/[\\/]/).at(-1) || "file",
          pathHint: value.value,
          requiresReselection: true,
        },
      };
    }
    return { kind: "text", name, value: value.value, enabled: true };
  });
}

function parseHashtablePairs(
  raw: string,
  warnings: ImportWarning[],
): Array<[string, { kind: "literal" | "file"; value: string }]> {
  const body = raw.trim().replace(/^@\{/, "").replace(/\}$/, "");
  const pairs: Array<[string, { kind: "literal" | "file"; value: string }]> =
    [];
  const pattern =
    /(?:^|[;\r\n])\s*(?:'((?:''|[^'])*)'|"([^"]*)"|([\w.-]+))\s*=\s*(?:(?:Get-Item\s+)?'((?:''|[^'])*)'|"([^"]*)"|([^;\r\n]+))/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const name = (match[1] ?? match[2] ?? match[3] ?? "").replaceAll("''", "'");
    const rawMatch = match[0];
    const value = (match[4] ?? match[5] ?? match[6] ?? "")
      .trim()
      .replaceAll("''", "'");
    if (/Get-Item/i.test(rawMatch)) {
      warnings.push(
        warning(
          "powershell.file_reselection_required",
          `File ${value} was not read and must be selected again.`,
        ),
      );
      pairs.push([name, { kind: "file", value }]);
    } else {
      pairs.push([name, { kind: "literal", value }]);
    }
  }
  if (pairs.length === 0 && body.trim()) {
    warnings.push(
      warning(
        "powershell.hashtable_unsupported",
        "The hashtable did not contain supported static key/value pairs.",
      ),
    );
  }
  return pairs;
}
