import { randomBytes } from "node:crypto";
import { open, readFile, type FileHandle } from "node:fs/promises";
import type {
  KeyValueItem,
  RedirectRecord,
  RequestSpecV1,
  ResponseRecordV1,
  TimingInfo,
} from "@xpanel/contracts";
import { NativeHostError } from "./errors.js";
import type { RequestStagingSession } from "./staging.js";
import { MAX_TRANSFER_BYTES } from "./constants.js";

const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~\dA-Za-z-]+$/;
const METHOD_PATTERN = /^[A-Z][A-Z\d-]*$/;
const ALLOWED_PROXY_PROTOCOLS = new Set([
  "http:",
  "https:",
  "socks4:",
  "socks4a:",
  "socks5:",
  "socks5h:",
]);
const FORBIDDEN_PART_HEADERS = new Set([
  "content-disposition",
  "content-length",
  "transfer-encoding",
]);

export interface PreparedCurlRequest {
  args: string[];
  bodyPath: string;
  headerPath: string;
  temporaryPaths: string[];
  request: RequestSpecV1;
  startedAt: string;
}

export interface CurlProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  cancelled: boolean;
}

export interface ParsedCurlResponse {
  response: Omit<ResponseRecordV1, "body">;
  bodyPath: string;
  mediaType: string | undefined;
}

function rejectControlCharacters(value: string, label: string): void {
  if (/[\0\r\n]/.test(value)) {
    throw new NativeHostError(
      "INVALID_REQUEST",
      `${label} contains a forbidden control character.`,
    );
  }
}

function assertHeader(name: string, value: string): void {
  if (!HEADER_NAME_PATTERN.test(name)) {
    throw new NativeHostError(
      "INVALID_REQUEST",
      `Invalid HTTP header name: ${name}`,
    );
  }
  rejectControlCharacters(value, `Header ${name}`);
}

function appendHeader(
  headers: KeyValueItem[],
  name: string,
  value: string,
  sensitive = true,
): void {
  assertHeader(name, value);
  headers.push({ name, value, enabled: true, sensitive });
}

function hasHeader(headers: readonly KeyValueItem[], name: string): boolean {
  return headers.some(
    (header) =>
      header.enabled &&
      header.name.localeCompare(name, undefined, { sensitivity: "accent" }) ===
        0,
  );
}

function redirectChangesMethod(status: number, method: string): boolean {
  return (
    ((status === 301 || status === 302) && method === "POST") ||
    (status === 303 && method !== "HEAD")
  );
}

export function redirectedRequest(
  request: RequestSpecV1,
  status: number,
  location: string,
): RequestSpecV1 | undefined {
  if (![301, 302, 303, 307, 308].includes(status)) return undefined;

  let target: URL;
  try {
    target = new URL(location, request.url);
  } catch (error) {
    throw new NativeHostError(
      "CURL_FAILED",
      "Redirect Location is not a valid URL.",
      { cause: error },
    );
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new NativeHostError(
      "CURL_FAILED",
      `Redirect to unsupported protocol ${target.protocol} was blocked.`,
    );
  }

  const originChanged = new URL(request.url).origin !== target.origin;
  const methodChanged = redirectChangesMethod(status, request.method);
  if (originChanged && !methodChanged && request.body.kind !== "none") {
    throw new NativeHostError(
      "CURL_FAILED",
      "Cross-origin redirect with a reusable request body was blocked.",
    );
  }
  const headers = request.headers.filter((header) => {
    const normalized = header.name.toLowerCase();
    if (
      methodChanged &&
      ["content-length", "content-type", "transfer-encoding"].includes(
        normalized,
      )
    ) {
      return false;
    }
    // All request headers are user-controlled. Their semantics cannot be safely
    // inferred, so none are forwarded across an origin boundary.
    if (originChanged) return false;
    return true;
  });
  const tls = originChanged
    ? {
        verify: request.options.tls.verify,
        ...(request.options.tls.caFile === undefined
          ? {}
          : { caFile: request.options.tls.caFile }),
      }
    : request.options.tls;
  const queryApiKey =
    request.auth.kind === "api-key" && request.auth.location === "query";

  return {
    ...request,
    method: methodChanged ? "GET" : request.method,
    url: target.toString(),
    query: [],
    headers,
    auth: originChanged || queryApiKey ? { kind: "none" } : request.auth,
    body: methodChanged ? { kind: "none" } : request.body,
    options: { ...request.options, tls },
  };
}

function quoteDispositionValue(value: string): string {
  rejectControlCharacters(value, "Multipart field name");
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function safeFilename(value: string): string {
  const normalized =
    value.normalize("NFKC").replaceAll("\\", "/").split("/").at(-1) ?? "file";
  const safe = normalized.replace(/[^\dA-Za-z._-]/g, "_").slice(0, 180);
  return safe.length === 0 || safe === "." || safe === ".." ? "file" : safe;
}

async function writeAll(
  handle: FileHandle,
  content: string | Uint8Array,
): Promise<void> {
  if (typeof content === "string") {
    await handle.write(content, undefined, "utf8");
  } else {
    await handle.write(content);
  }
}

async function copyFileInto(
  sourcePath: string,
  target: FileHandle,
): Promise<void> {
  const source = await open(sourcePath, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let position = 0;
    while (true) {
      const { bytesRead } = await source.read(
        buffer,
        0,
        buffer.byteLength,
        position,
      );
      if (bytesRead === 0) {
        break;
      }
      await target.write(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await source.close();
  }
}

async function createMultipartBody(
  request: RequestSpecV1,
  session: RequestStagingSession,
): Promise<{ bodyPath: string; contentType: string }> {
  if (request.body.kind !== "multipart") {
    throw new NativeHostError(
      "INTERNAL_ERROR",
      "Expected a multipart request body.",
    );
  }
  const boundary = `----------------xpanel-${randomBytes(18).toString("hex")}`;
  const generated = await session.openGeneratedFile();
  try {
    for (const part of request.body.parts) {
      if (!part.enabled) {
        continue;
      }
      const name = quoteDispositionValue(part.name);
      await writeAll(generated.handle, `--${boundary}\r\n`);
      if (part.kind === "text") {
        await writeAll(
          generated.handle,
          `Content-Disposition: form-data; name="${name}"\r\n`,
        );
      } else {
        const staged = session.resolve(part.file.id, "multipart");
        const filename = quoteDispositionValue(
          safeFilename(part.file.name || staged.name),
        );
        await writeAll(
          generated.handle,
          `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n`,
        );
        await writeAll(
          generated.handle,
          `Content-Type: ${part.file.mediaType ?? "application/octet-stream"}\r\n`,
        );
      }

      for (const header of part.headers ?? []) {
        if (!header.enabled) {
          continue;
        }
        assertHeader(header.name, header.value);
        if (FORBIDDEN_PART_HEADERS.has(header.name.toLowerCase())) {
          throw new NativeHostError(
            "INVALID_REQUEST",
            `Multipart header ${header.name} must be generated by xPanel.`,
          );
        }
        await writeAll(generated.handle, `${header.name}: ${header.value}\r\n`);
      }
      await writeAll(generated.handle, "\r\n");
      if (part.kind === "text") {
        await writeAll(generated.handle, part.value);
      } else {
        await copyFileInto(
          session.resolve(part.file.id, "multipart").path,
          generated.handle,
        );
      }
      await writeAll(generated.handle, "\r\n");
    }
    await writeAll(generated.handle, `--${boundary}--\r\n`);
  } finally {
    await generated.handle.close();
  }
  return {
    bodyPath: generated.path,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function applyAuth(
  request: RequestSpecV1,
  url: URL,
  headers: KeyValueItem[],
): void {
  switch (request.auth.kind) {
    case "none":
      return;
    case "basic":
      appendHeader(
        headers,
        "Authorization",
        `Basic ${Buffer.from(`${request.auth.username}:${request.auth.password}`, "utf8").toString("base64")}`,
      );
      return;
    case "bearer":
      appendHeader(headers, "Authorization", `Bearer ${request.auth.token}`);
      return;
    case "oauth2":
      appendHeader(
        headers,
        "Authorization",
        `${request.auth.tokenType} ${request.auth.accessToken}`,
      );
      return;
    case "api-key":
      if (request.auth.location === "header") {
        appendHeader(headers, request.auth.name, request.auth.value);
      } else if (request.auth.location === "query") {
        rejectControlCharacters(request.auth.name, "API key name");
        url.searchParams.append(request.auth.name, request.auth.value);
      } else {
        rejectControlCharacters(request.auth.name, "Cookie name");
        rejectControlCharacters(request.auth.value, "Cookie value");
        const existingCookie = headers.find(
          (header) => header.enabled && header.name.toLowerCase() === "cookie",
        );
        if (existingCookie === undefined) {
          appendHeader(
            headers,
            "Cookie",
            `${request.auth.name}=${request.auth.value}`,
          );
        } else {
          existingCookie.value = `${existingCookie.value}; ${request.auth.name}=${request.auth.value}`;
        }
      }
  }
}

function validateProxyUrl(value: string): string {
  rejectControlCharacters(value, "Proxy URL");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new NativeHostError("INVALID_REQUEST", "Proxy URL is invalid.", {
      cause: error,
    });
  }
  if (!ALLOWED_PROXY_PROTOCOLS.has(parsed.protocol)) {
    throw new NativeHostError(
      "INVALID_REQUEST",
      `Unsupported proxy protocol: ${parsed.protocol}`,
    );
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new NativeHostError(
      "INVALID_REQUEST",
      "Proxy credentials must use the structured username/password fields.",
    );
  }
  return parsed.toString();
}

export async function prepareCurlRequest(
  request: RequestSpecV1,
  session: RequestStagingSession,
): Promise<PreparedCurlRequest> {
  if (!METHOD_PATTERN.test(request.method)) {
    throw new NativeHostError("INVALID_REQUEST", "HTTP method is invalid.");
  }
  let url: URL;
  try {
    url = new URL(request.url);
  } catch (error) {
    throw new NativeHostError("INVALID_REQUEST", "Request URL is invalid.", {
      cause: error,
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new NativeHostError(
      "INVALID_REQUEST",
      "Native requests only support HTTP and HTTPS URLs.",
    );
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new NativeHostError(
      "INVALID_REQUEST",
      "URL credentials are not accepted; use structured authentication instead.",
    );
  }
  for (const query of request.query) {
    if (query.enabled) {
      url.searchParams.append(query.name, query.value);
    }
  }

  const headers = request.headers
    .filter((header) => header.enabled)
    .map((header) => ({ ...header }));
  for (const header of headers) {
    assertHeader(header.name, header.value);
  }
  applyAuth(request, url, headers);

  let requestBodyPath: string | undefined;
  const temporaryPaths: string[] = [];
  if (request.body.kind === "file") {
    requestBodyPath = session.resolve(request.body.file.id, "body").path;
    if (!hasHeader(headers, "Content-Type")) {
      appendHeader(
        headers,
        "Content-Type",
        request.body.mediaType ??
          request.body.file.mediaType ??
          "application/octet-stream",
        false,
      );
    }
  } else if (request.body.kind === "text" || request.body.kind === "json") {
    requestBodyPath = await session.createGeneratedFile(request.body.text);
    temporaryPaths.push(requestBodyPath);
    if (!hasHeader(headers, "Content-Type")) {
      appendHeader(
        headers,
        "Content-Type",
        request.body.mediaType ??
          (request.body.kind === "json"
            ? "application/json"
            : "text/plain; charset=utf-8"),
        false,
      );
    }
  } else if (request.body.kind === "urlencoded") {
    const form = new URLSearchParams();
    for (const entry of request.body.entries) {
      if (entry.enabled) {
        form.append(entry.name, entry.value);
      }
    }
    requestBodyPath = await session.createGeneratedFile(form.toString());
    temporaryPaths.push(requestBodyPath);
    if (!hasHeader(headers, "Content-Type")) {
      appendHeader(
        headers,
        "Content-Type",
        "application/x-www-form-urlencoded",
        false,
      );
    }
  } else if (request.body.kind === "multipart") {
    const multipart = await createMultipartBody(request, session);
    requestBodyPath = multipart.bodyPath;
    temporaryPaths.push(requestBodyPath);
    if (!hasHeader(headers, "Content-Type")) {
      appendHeader(headers, "Content-Type", multipart.contentType, false);
    }
  }

  const headerPath = await session.createGeneratedFile();
  const bodyPath = await session.createGeneratedFile();
  temporaryPaths.push(headerPath, bodyPath);
  const args = [
    "--disable",
    "--silent",
    "--show-error",
    "--globoff",
    "--proto",
    "=http,https",
    "--proto-redir",
    "=http,https",
    "--request",
    request.method,
    "--max-time",
    (request.options.timeoutMs / 1000).toFixed(3),
    "--max-filesize",
    String(MAX_TRANSFER_BYTES),
    "--dump-header",
    headerPath,
    "--output",
    bodyPath,
    "--write-out",
    "%{json}",
  ];

  if (!request.options.tls.verify) {
    args.push("--insecure");
  }
  if (request.options.tls.caFile !== undefined) {
    args.push(
      "--cacert",
      session.resolve(request.options.tls.caFile.id, "ca").path,
    );
  }
  if (request.options.tls.clientCertificate !== undefined) {
    const certificate = request.options.tls.clientCertificate;
    args.push(
      "--cert",
      session.resolve(certificate.certificate.id, "clientCert").path,
    );
    args.push(
      "--key",
      session.resolve(certificate.privateKey.id, "clientKey").path,
    );
    if (certificate.passphrase !== undefined) {
      rejectControlCharacters(
        certificate.passphrase,
        "Client certificate passphrase",
      );
      args.push("--pass", certificate.passphrase);
    }
  }
  if (request.options.proxy !== null) {
    args.push("--proxy", validateProxyUrl(request.options.proxy.url));
    if (
      request.options.proxy.username !== undefined ||
      request.options.proxy.password !== undefined
    ) {
      const username = request.options.proxy.username ?? "";
      const password = request.options.proxy.password ?? "";
      rejectControlCharacters(username, "Proxy username");
      rejectControlCharacters(password, "Proxy password");
      args.push("--proxy-user", `${username}:${password}`);
    }
    if (request.options.proxy.bypass.length > 0) {
      for (const bypass of request.options.proxy.bypass) {
        rejectControlCharacters(bypass, "Proxy bypass entry");
      }
      args.push("--noproxy", request.options.proxy.bypass.join(","));
    }
  }
  for (const header of headers) {
    args.push("--header", `${header.name}: ${header.value}`);
  }
  if (requestBodyPath !== undefined) {
    args.push("--data-binary", `@${requestBodyPath}`);
  }
  args.push("--url", url.toString());

  return {
    args,
    bodyPath,
    headerPath,
    temporaryPaths,
    request,
    startedAt: new Date().toISOString(),
  };
}

interface HeaderBlock {
  status: number;
  statusText: string;
  headers: KeyValueItem[];
}

function parseHeaderBlocks(value: string): HeaderBlock[] {
  const blocks: HeaderBlock[] = [];
  for (const rawBlock of value.split(/\r?\n\r?\n/)) {
    const lines = rawBlock.split(/\r?\n/).filter((line) => line.length > 0);
    const statusLine = lines.shift();
    if (statusLine === undefined) {
      continue;
    }
    const match = /^HTTP\/\S+\s+(\d{3})(?:\s+(.*))?$/.exec(statusLine);
    if (match === null) {
      continue;
    }
    const headers: KeyValueItem[] = [];
    for (const line of lines) {
      const separator = line.indexOf(":");
      if (separator <= 0) {
        continue;
      }
      headers.push({
        name: line.slice(0, separator).trim(),
        value: line.slice(separator + 1).trim(),
        enabled: true,
      });
    }
    blocks.push({
      status: Number(match[1]),
      statusText: match[2] ?? "",
      headers,
    });
  }
  return blocks;
}

function milliseconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value * 1_000_000) / 1000
    : undefined;
}

function parseCurlMetrics(stdout: Buffer): Record<string, unknown> {
  if (stdout.byteLength === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(stdout.toString("utf8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function contentType(headers: readonly KeyValueItem[]): string | undefined {
  return headers
    .find((header) => header.name.toLowerCase() === "content-type")
    ?.value.split(";")[0]
    ?.trim();
}

export async function parseCurlResponse(
  prepared: PreparedCurlRequest,
  result: CurlProcessResult,
): Promise<ParsedCurlResponse> {
  if (result.cancelled) {
    throw new NativeHostError("CANCELLED", "Request was cancelled.");
  }
  const metrics = parseCurlMetrics(result.stdout);
  const blocks = parseHeaderBlocks(await readFile(prepared.headerPath, "utf8"));
  const finalBlock = blocks.at(-1);
  const status = finalBlock?.status ?? Number(metrics["http_code"] ?? 0);
  if (result.exitCode !== 0) {
    const diagnostic = result.stderr.toString("utf8").trim().slice(0, 4096);
    throw new NativeHostError(
      "CURL_FAILED",
      diagnostic.length > 0
        ? diagnostic
        : `curl exited with code ${String(result.exitCode)}.`,
      {
        details: { exitCode: result.exitCode, signal: result.signal },
        retryable: true,
      },
    );
  }
  if (
    prepared.request.options.redirect === "error" &&
    status >= 300 &&
    status < 400
  ) {
    throw new NativeHostError(
      "CURL_FAILED",
      `Redirect response ${status} was rejected by request policy.`,
    );
  }

  const timing: TimingInfo = {
    startedAt: prepared.startedAt,
    durationMs: milliseconds(metrics["time_total"]) ?? 0,
  };
  const dnsMs = milliseconds(metrics["time_namelookup"]);
  const connectMs = milliseconds(metrics["time_connect"]);
  const tlsMs = milliseconds(metrics["time_appconnect"]);
  const ttfbMs = milliseconds(metrics["time_starttransfer"]);
  if (dnsMs !== undefined) timing.dnsMs = dnsMs;
  if (connectMs !== undefined) timing.connectMs = connectMs;
  if (tlsMs !== undefined) timing.tlsMs = tlsMs;
  if (ttfbMs !== undefined) timing.ttfbMs = ttfbMs;
  const downloadMs = timing.durationMs - (ttfbMs ?? 0);
  if (downloadMs >= 0) timing.downloadMs = downloadMs;

  const redirects: RedirectRecord[] = [];
  for (const block of blocks.slice(0, -1)) {
    if (block.status < 300 || block.status >= 400) continue;
    const location = block.headers.find(
      (header) => header.name.toLowerCase() === "location",
    )?.value;
    if (location === undefined) continue;
    redirects.push({
      url: new URL(location, prepared.request.url).toString(),
      status: block.status,
      method: prepared.request.method,
    });
  }

  return {
    bodyPath: prepared.bodyPath,
    mediaType: contentType(finalBlock?.headers ?? []),
    response: {
      requestId: prepared.request.id,
      executor: "native",
      status: Number.isInteger(status) ? status : 0,
      statusText: finalBlock?.statusText ?? "",
      headers: finalBlock?.headers ?? [],
      timings: timing,
      redirects,
      warnings:
        prepared.request.options.cookieMode === "include"
          ? [
              {
                code: "NATIVE_NO_AMBIENT_COOKIES",
                message:
                  "Native execution only sends cookies explicitly present in the request.",
              },
            ]
          : [],
    },
  };
}

export function sanitizedCurlEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const result = { ...environment };
  for (const key of Object.keys(result)) {
    if (
      /^(?:all|http|https|ftp|no)_proxy$/i.test(key) ||
      /^(?:curl_home|curl_ca_bundle)$/i.test(key)
    ) {
      delete result[key];
    }
  }
  return result;
}
