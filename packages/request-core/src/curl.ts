import type {
  ImportWarning,
  KeyValueItem,
  MultipartPart,
  FileReferenceV1,
  RequestSpecV1,
} from "@xpanel/contracts";

import {
  detectBody,
  extractStructuredAuth,
  makeRequest,
  materializeAuth,
  prepareRequestForExport,
  normalizeMethod,
  parseHeaderLine,
  powerShellSingleQuote,
  requestUrl,
  safeId,
  shellSingleQuote,
  splitUrlQuery,
  warning,
} from "./common.js";

export interface RequestParseResult {
  requests: RequestSpecV1[];
  warnings: ImportWarning[];
}

interface TokenizeResult {
  tokens: string[];
  warnings: ImportWarning[];
}

const VALUE_OPTIONS = new Set([
  "-X",
  "--request",
  "-H",
  "--header",
  "-d",
  "--data",
  "--data-raw",
  "--data-binary",
  "--data-urlencode",
  "-F",
  "--form",
  "--url",
  "--max-time",
  "-u",
  "--user",
  "-x",
  "--proxy",
  "--proxy-user",
  "--noproxy",
  "--cacert",
  "--cert",
  "--key",
  "-b",
  "--cookie",
  "-K",
  "--config",
]);

export function parseCurlBash(input: string): RequestParseResult {
  const commands = splitCurlCommands(input);
  if (commands.length === 0) {
    return {
      requests: [],
      warnings: [warning("curl.command_missing", "No cURL command was found.")],
    };
  }

  const requests: RequestSpecV1[] = [];
  const warnings: ImportWarning[] = [];
  for (const [commandIndex, command] of commands.entries()) {
    const parsed = parseCurlCommand(command, commandIndex);
    warnings.push(...parsed.warnings);
    if (parsed.request) requests.push(parsed.request);
  }
  return { requests, warnings };
}

function parseCurlCommand(
  command: string,
  commandIndex: number,
): { request?: RequestSpecV1; warnings: ImportWarning[] } {
  const lexed = tokenizeBash(command);
  const warnings = [...lexed.warnings];
  const tokens = [...lexed.tokens];
  if (tokens[0]?.toLowerCase().endsWith("curl.exe")) tokens.shift();
  else if (tokens[0]?.toLowerCase() === "curl") tokens.shift();
  else {
    warnings.push(
      warning(
        "curl.command_invalid",
        "Only a static curl/curl.exe command is accepted.",
        `commands[${commandIndex}]`,
      ),
    );
    return { warnings };
  }

  let method: string | undefined;
  let rawUrl: string | undefined;
  let bodyKind: "data" | "multipart" | undefined;
  let followRedirects = false;
  let timeoutMs: number | undefined;
  let proxyUrl: string | undefined;
  let proxyUsername: string | undefined;
  let proxyPassword: string | undefined;
  let proxyBypass: string[] = [];
  let caFile: FileReferenceV1 | undefined;
  let certificateFile: FileReferenceV1 | undefined;
  let privateKeyFile: FileReferenceV1 | undefined;
  let certificatePassphrase: string | undefined;
  let rawBodyFile: FileReferenceV1 | undefined;
  const headers: KeyValueItem[] = [];
  const data: string[] = [];
  const parts: MultipartPart[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    let token = tokens[index] ?? "";
    if (!token) continue;
    let inlineValue: string | undefined;
    const equalsIndex = token.indexOf("=");
    if (token.startsWith("--") && equalsIndex > 2) {
      inlineValue = token.slice(equalsIndex + 1);
      token = token.slice(0, equalsIndex);
    }

    const value =
      inlineValue ?? (VALUE_OPTIONS.has(token) ? tokens[index + 1] : undefined);
    if (inlineValue === undefined && VALUE_OPTIONS.has(token)) index += 1;

    switch (token) {
      case "-X":
      case "--request":
        if (value) method = normalizeMethod(value);
        break;
      case "--url":
        rawUrl = value;
        break;
      case "-H":
      case "--header": {
        if (!value) break;
        const header = parseHeaderLine(value);
        if (header) headers.push(header);
        else {
          warnings.push(
            warning(
              "curl.header_invalid",
              `Skipped malformed header: ${value}`,
            ),
          );
        }
        break;
      }
      case "-d":
      case "--data":
      case "--data-raw":
      case "--data-binary":
      case "--data-urlencode":
        bodyKind = "data";
        if (value?.startsWith("@") && token !== "--data-raw") {
          rawBodyFile = pathFileReference(value.slice(1), "body");
          warnings.push(
            warning(
              "curl.file_reselection_required",
              `File body ${value} was not read and must be selected again.`,
            ),
          );
        } else if (value !== undefined) {
          data.push(value);
        }
        break;
      case "-F":
      case "--form":
        bodyKind = "multipart";
        if (value) parts.push(parseFormPart(value, warnings));
        break;
      case "-L":
      case "--location":
        followRedirects = true;
        index -= VALUE_OPTIONS.has(token) ? 1 : 0;
        break;
      case "--max-time": {
        const seconds = Number(value);
        if (Number.isFinite(seconds) && seconds > 0) timeoutMs = seconds * 1000;
        break;
      }
      case "-b":
      case "--cookie":
        if (value?.startsWith("@")) {
          warnings.push(
            warning(
              "curl.cookie_file_unsupported",
              "Cookie files are never read during import.",
            ),
          );
        } else if (value) {
          headers.push({
            name: "Cookie",
            value,
            enabled: true,
            sensitive: true,
          });
        }
        break;
      case "-u":
      case "--user":
        warnings.push(
          warning(
            "curl.auth_imported",
            "Basic credentials were imported into the structured auth field.",
          ),
        );
        break;
      case "-x":
      case "--proxy":
        proxyUrl = value;
        warnings.push(
          warning(
            "curl.browser_unsupported_option",
            `${token} was detected. Browser execution cannot apply an explicit proxy; its structure is preserved for import and export.`,
          ),
        );
        break;
      case "--proxy-user":
        if (value) {
          const separator = value.indexOf(":");
          proxyUsername = separator < 0 ? value : value.slice(0, separator);
          proxyPassword = separator < 0 ? "" : value.slice(separator + 1);
        }
        warnings.push(
          warning(
            "curl.browser_unsupported_option",
            `${token} was detected. Browser execution cannot apply proxy credentials; their structure is preserved for import and export.`,
          ),
        );
        break;
      case "--noproxy":
        proxyBypass = value
          ? value
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean)
          : [];
        warnings.push(
          warning(
            "curl.browser_unsupported_option",
            `${token} was detected. Browser execution cannot apply proxy bypass rules; their structure is preserved for import and export.`,
          ),
        );
        break;
      case "--cacert":
        if (value) caFile = pathFileReference(value, "ca");
        warnings.push(
          warning(
            "curl.browser_unsupported_option",
            `${token} was detected. Browser execution cannot apply this local TLS option; its structure is preserved for import and export.`,
          ),
        );
        break;
      case "--cert":
        if (value) {
          const parsed = splitCertificateValue(value);
          certificateFile = pathFileReference(parsed.path, "certificate");
          certificatePassphrase = parsed.passphrase;
        }
        warnings.push(
          warning(
            "curl.browser_unsupported_option",
            `${token} was detected. Browser execution cannot apply this local TLS option; its structure is preserved for import and export.`,
          ),
        );
        break;
      case "--key":
        if (value) privateKeyFile = pathFileReference(value, "private-key");
        warnings.push(
          warning(
            "curl.browser_unsupported_option",
            `${token} was detected. Browser execution cannot apply this local TLS option; its structure is preserved for import and export.`,
          ),
        );
        break;
      case "--config":
      case "-K":
        warnings.push(
          warning(
            "curl.config_forbidden",
            "cURL config files are never read or executed.",
          ),
        );
        break;
      case "--insecure":
      case "-k":
        warnings.push(
          warning(
            "curl.tls_insecure",
            "TLS verification was disabled by the imported command. Browser execution cannot apply this option.",
          ),
        );
        break;
      default:
        if (!token.startsWith("-") && rawUrl === undefined) rawUrl = token;
        else if (token.startsWith("-")) {
          warnings.push(
            warning(
              "curl.option_unsupported",
              `Unsupported cURL option: ${token}`,
            ),
          );
        }
    }
  }

  if (!rawUrl) {
    warnings.push(
      warning("curl.url_missing", "The cURL command has no static URL."),
    );
    return { warnings };
  }
  const split = splitUrlQuery(rawUrl);
  const extracted = extractStructuredAuth(headers, split.query);
  const body =
    bodyKind === "multipart"
      ? ({ kind: "multipart", parts } as const)
      : rawBodyFile
        ? ({ kind: "file", file: rawBodyFile } as const)
        : detectBody(data.length ? data.join("&") : undefined, headers);
  const request = makeRequest(
    { format: "curl-bash" },
    {
      name: `Imported cURL ${commandIndex + 1}`,
      method: method ?? (body.kind === "none" ? "GET" : "POST"),
      url: split.url,
      query: extracted.query,
      headers: extracted.headers,
      auth: extracted.auth,
      body,
      options: {
        redirect: followRedirects ? "follow" : "manual",
        cookieMode: "include",
        timeoutMs: timeoutMs ?? 30_000,
        proxy: proxyUrl
          ? {
              url: proxyUrl,
              ...(proxyUsername === undefined
                ? {}
                : { username: proxyUsername }),
              ...(proxyPassword === undefined
                ? {}
                : { password: proxyPassword }),
              bypass: proxyBypass,
            }
          : null,
        tls: {
          verify: !tokens.includes("-k") && !tokens.includes("--insecure"),
          ...(caFile ? { caFile } : {}),
          ...(certificateFile && privateKeyFile
            ? {
                clientCertificate: {
                  certificate: certificateFile,
                  privateKey: privateKeyFile,
                  ...(certificatePassphrase === undefined
                    ? {}
                    : { passphrase: certificatePassphrase }),
                },
              }
            : {}),
        },
      },
      warnings,
    },
  );
  const authTokenIndex = tokens.findIndex(
    (token) => token === "-u" || token === "--user",
  );
  const credentials =
    authTokenIndex >= 0 ? tokens[authTokenIndex + 1] : undefined;
  if (credentials) {
    const separator = credentials.indexOf(":");
    request.auth = {
      kind: "basic",
      username: separator < 0 ? credentials : credentials.slice(0, separator),
      password: separator < 0 ? "" : credentials.slice(separator + 1),
    };
  }
  return { request, warnings };
}

function parseFormPart(
  value: string,
  warnings: ImportWarning[],
): MultipartPart {
  const equalsIndex = value.indexOf("=");
  const name = equalsIndex < 0 ? value : value.slice(0, equalsIndex);
  const content = equalsIndex < 0 ? "" : value.slice(equalsIndex + 1);
  if (content.startsWith("@") || content.startsWith("<")) {
    const pathHint = content.slice(1).split(";", 1)[0] ?? "";
    warnings.push(
      warning(
        "curl.file_reselection_required",
        `Multipart file ${pathHint} must be selected again.`,
      ),
    );
    return {
      kind: "file",
      name,
      enabled: true,
      file: {
        id: safeId("file"),
        name: pathHint.split(/[\\/]/).at(-1) || "file",
        pathHint,
        requiresReselection: true,
      },
    };
  }
  return { kind: "text", name, value: content, enabled: true };
}

export function exportCurlBash(
  input: RequestSpecV1,
  options: { includeSensitive?: boolean } = {},
): { text: string; warnings: ImportWarning[] } {
  const prepared = prepareRequestForExport(input, options.includeSensitive);
  const redacted = prepared.request;
  const basicAuth = redacted.auth.kind === "basic" ? redacted.auth : undefined;
  const request = basicAuth ? redacted : materializeAuth(redacted);
  const args = ["curl", shellSingleQuote(requestUrl(request))];
  const warnings: ImportWarning[] = [...prepared.warnings];
  if (request.method !== "GET")
    args.push("-X", shellSingleQuote(request.method));
  if (basicAuth) {
    args.push(
      "--user",
      shellSingleQuote(`${basicAuth.username}:${basicAuth.password}`),
    );
  }
  for (const header of request.headers.filter(
    (item) => item.enabled !== false,
  )) {
    args.push("-H", shellSingleQuote(`${header.name}: ${header.value}`));
  }
  if (request.options.redirect === "follow") args.push("--location");
  if (request.options.proxy) {
    args.push("--proxy", shellSingleQuote(request.options.proxy.url));
    if (request.options.proxy.username !== undefined) {
      args.push(
        "--proxy-user",
        shellSingleQuote(
          `${request.options.proxy.username}:${request.options.proxy.password ?? ""}`,
        ),
      );
    }
    if (request.options.proxy.bypass.length) {
      args.push(
        "--noproxy",
        shellSingleQuote(request.options.proxy.bypass.join(",")),
      );
    }
  }
  if (!request.options.tls.verify) args.push("--insecure");
  if (request.options.tls.caFile) {
    args.push(
      "--cacert",
      shellSingleQuote(
        request.options.tls.caFile.pathHint ?? request.options.tls.caFile.name,
      ),
    );
  }
  if (request.options.tls.clientCertificate) {
    const client = request.options.tls.clientCertificate;
    const certificate = client.certificate.pathHint ?? client.certificate.name;
    const privateKey = client.privateKey.pathHint ?? client.privateKey.name;
    args.push(
      "--cert",
      shellSingleQuote(
        client.passphrase ? `${certificate}:${client.passphrase}` : certificate,
      ),
      "--key",
      shellSingleQuote(privateKey),
    );
  }
  if (request.options.timeoutMs > 0) {
    args.push("--max-time", String(request.options.timeoutMs / 1000));
  }
  switch (request.body.kind) {
    case "none":
      break;
    case "text":
    case "json":
      args.push("--data-raw", shellSingleQuote(request.body.text));
      break;
    case "urlencoded":
      for (const entry of request.body.entries.filter(
        (item) => item.enabled !== false,
      )) {
        args.push(
          "--data-urlencode",
          shellSingleQuote(`${entry.name}=${entry.value}`),
        );
      }
      break;
    case "multipart":
      for (const part of request.body.parts.filter(
        (item) => item.enabled !== false,
      )) {
        if (part.kind === "text") {
          args.push("--form", shellSingleQuote(`${part.name}=${part.value}`));
        } else {
          const path = part.file.pathHint ?? part.file.name;
          args.push("--form", shellSingleQuote(`${part.name}=@${path}`));
          warnings.push(
            warning(
              "export.file_path_hint",
              `Exported ${path} as a path hint; the receiver must reselect it.`,
            ),
          );
        }
      }
      break;
    case "file": {
      const path = request.body.file.pathHint ?? request.body.file.name;
      args.push("--data-binary", shellSingleQuote(`@${path}`));
      warnings.push(
        warning(
          "export.file_path_hint",
          `Exported ${path} as a path hint; the receiver must reselect it.`,
        ),
      );
      break;
    }
  }
  return { text: joinShellArgs(args), warnings };
}

export function exportCurlPowerShellAlias(request: RequestSpecV1): string {
  return `curl.exe ${powerShellSingleQuote(requestUrl(request))}`;
}

function joinShellArgs(args: string[]): string {
  return args
    .map((arg, index) => (index === 0 ? arg : `  ${arg}`))
    .join(" \\\n");
}

function pathFileReference(pathHint: string, prefix: string): FileReferenceV1 {
  return {
    id: safeId(prefix),
    name: pathHint.split(/[\\/]/).at(-1) || prefix,
    pathHint,
    requiresReselection: true,
  };
}

function splitCertificateValue(value: string): {
  path: string;
  passphrase?: string;
} {
  const separator = value.lastIndexOf(":");
  const isWindowsDriveOnly = separator === 1 && /^[A-Za-z]:[\\/]/.test(value);
  if (separator <= 0 || isWindowsDriveOnly) return { path: value };
  return {
    path: value.slice(0, separator),
    passphrase: value.slice(separator + 1),
  };
}

function splitCurlCommands(input: string): string[] {
  const normalized = input.replace(/\\\r?\n/g, " ");
  const starts: number[] = [];
  const pattern = /(^|\r?\n)\s*(?:curl(?:\.exe)?)(?=\s)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(normalized)) !== null) {
    starts.push(match.index + match[0].search(/curl/i));
  }
  if (starts.length === 0 && /^\s*curl(?:\.exe)?\s/i.test(normalized)) {
    return [normalized.trim()];
  }
  return starts.map((start, index) =>
    normalized.slice(start, starts[index + 1] ?? normalized.length).trim(),
  );
}

function tokenizeBash(input: string): TokenizeResult {
  const tokens: string[] = [];
  const warnings: ImportWarning[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  const push = (): void => {
    if (token !== "") tokens.push(token);
    token = "";
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? "";
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else token += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (char === "\\") escaped = true;
      else {
        if (char === "$" || char === "`") {
          warnings.push(
            warning(
              "bash.dynamic_expression",
              "A dynamic expression was preserved as text and was not evaluated.",
            ),
          );
        }
        token += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "\\") {
      escaped = true;
    } else if (/\s/.test(char)) {
      push();
    } else if (
      char === "|" ||
      char === ";" ||
      char === "`" ||
      char === "&" ||
      char === ">" ||
      char === "<"
    ) {
      warnings.push(
        warning(
          "bash.script_ignored",
          "Shell operators and substitutions are never executed.",
        ),
      );
      push();
    } else {
      if (char === "$") {
        warnings.push(
          warning(
            "bash.dynamic_expression",
            "Shell variables are not expanded during import.",
          ),
        );
      }
      token += char;
    }
  }
  if (quote)
    warnings.push(warning("bash.quote_unclosed", "Unclosed shell quote."));
  push();
  return { tokens, warnings };
}
