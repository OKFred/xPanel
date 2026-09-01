import {
  createDefaultRequest,
  redactRequestForExport,
  type AuthSpec,
  type ImportSource,
  type ImportWarning,
  type KeyValueItem,
  type RequestSpecV1,
} from "@xpanel/contracts";

export function warning(
  code: string,
  message: string,
  path?: string,
): ImportWarning {
  return { code, message, ...(path ? { path } : {}) };
}

export function makeRequest(
  source: ImportSource,
  value: Partial<RequestSpecV1>,
): RequestSpecV1 {
  const request = createDefaultRequest({ source, ...value });
  return request;
}

export function enabledEntries(items: KeyValueItem[]): KeyValueItem[] {
  return items.filter(
    (item) => item.enabled !== false && item.name.trim() !== "",
  );
}

export function toHeaderRecord(items: KeyValueItem[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const item of enabledEntries(items)) {
    record[item.name] = item.value;
  }
  return record;
}

export function maybeRedactRequest(
  request: RequestSpecV1,
  includeSensitive = false,
): RequestSpecV1 {
  return prepareRequestForExport(request, includeSensitive).request;
}

export function prepareRequestForExport(
  request: RequestSpecV1,
  includeSensitive = false,
): { request: RequestSpecV1; warnings: ImportWarning[] } {
  if (includeSensitive) {
    return { request: structuredClone(request), warnings: [] };
  }
  const result = redactRequestForExport(request);
  return { request: result.value, warnings: result.warnings };
}

export function materializeAuth(input: RequestSpecV1): RequestSpecV1 {
  const request = structuredClone(input);
  const auth = request.auth;
  const addHeader = (name: string, value: string): void => {
    if (
      !request.headers.some(
        (item) => item.name.toLowerCase() === name.toLowerCase(),
      )
    ) {
      request.headers.push({ name, value, enabled: true, sensitive: true });
    }
  };
  switch (auth.kind) {
    case "none":
      break;
    case "basic":
      addHeader(
        "Authorization",
        `Basic ${base64Utf8(`${auth.username}:${auth.password}`)}`,
      );
      break;
    case "bearer":
      addHeader("Authorization", `Bearer ${auth.token}`);
      break;
    case "oauth2":
      addHeader("Authorization", `${auth.tokenType} ${auth.accessToken}`);
      break;
    case "api-key":
      if (auth.location === "header") {
        addHeader(auth.name, auth.value);
      } else if (auth.location === "query") {
        if (!request.query.some((item) => item.name === auth.name)) {
          request.query.push({
            name: auth.name,
            value: auth.value,
            enabled: true,
            sensitive: true,
          });
        }
      } else {
        const cookie = request.headers.find(
          (item) => item.name.toLowerCase() === "cookie",
        );
        if (cookie) {
          cookie.value = `${cookie.value}; ${auth.name}=${auth.value}`;
        } else {
          addHeader("Cookie", `${auth.name}=${auth.value}`);
        }
      }
  }
  return request;
}

export function extractStructuredAuth(
  headers: KeyValueItem[],
  query: KeyValueItem[],
): { auth: AuthSpec; headers: KeyValueItem[]; query: KeyValueItem[] } {
  const nextHeaders = structuredClone(headers);
  const nextQuery = structuredClone(query);
  const authorizationIndex = nextHeaders.findIndex(
    (item) => item.name.toLowerCase() === "authorization",
  );
  if (authorizationIndex >= 0) {
    const authorization = nextHeaders[authorizationIndex];
    if (authorization) {
      const bearer = /^Bearer\s+(.+)$/i.exec(authorization.value);
      if (bearer?.[1]) {
        nextHeaders.splice(authorizationIndex, 1);
        return {
          auth: { kind: "bearer", token: bearer[1] },
          headers: nextHeaders,
          query: nextQuery,
        };
      }
      const basic = /^Basic\s+(.+)$/i.exec(authorization.value);
      if (basic?.[1]) {
        const decoded = decodeBase64Utf8(basic[1]);
        if (decoded !== undefined) {
          const separator = decoded.indexOf(":");
          nextHeaders.splice(authorizationIndex, 1);
          return {
            auth: {
              kind: "basic",
              username: separator < 0 ? decoded : decoded.slice(0, separator),
              password: separator < 0 ? "" : decoded.slice(separator + 1),
            },
            headers: nextHeaders,
            query: nextQuery,
          };
        }
      }
    }
  }
  const apiKeyHeaderIndex = nextHeaders.findIndex(
    (item) => item.name.toLowerCase() === "x-api-key",
  );
  const apiKeyHeader = nextHeaders[apiKeyHeaderIndex];
  if (apiKeyHeader) {
    nextHeaders.splice(apiKeyHeaderIndex, 1);
    return {
      auth: {
        kind: "api-key",
        location: "header",
        name: apiKeyHeader.name,
        value: apiKeyHeader.value,
      },
      headers: nextHeaders,
      query: nextQuery,
    };
  }
  return { auth: { kind: "none" }, headers: nextHeaders, query: nextQuery };
}

export function parseHeaderLine(line: string): KeyValueItem | undefined {
  const index = line.indexOf(":");
  if (index <= 0) return undefined;
  return {
    name: line.slice(0, index).trim(),
    value: line.slice(index + 1).trim(),
    enabled: true,
  };
}

export function requestUrl(request: RequestSpecV1): string {
  const url = new URL(request.url);
  for (const entry of enabledEntries(request.query)) {
    url.searchParams.append(entry.name, entry.value);
  }
  return url.toString();
}

export function requestBodyText(request: RequestSpecV1): string | undefined {
  switch (request.body.kind) {
    case "none":
      return undefined;
    case "json":
    case "text":
      return request.body.text;
    case "urlencoded": {
      const params = new URLSearchParams();
      for (const entry of enabledEntries(request.body.entries)) {
        params.append(entry.name, entry.value);
      }
      return params.toString();
    }
    case "multipart":
    case "file":
      return undefined;
  }
}

export function detectBody(
  text: string | undefined,
  headers: KeyValueItem[],
): RequestSpecV1["body"] {
  if (text === undefined) return { kind: "none" };
  const contentType = headers
    .find((header) => header.name.toLowerCase() === "content-type")
    ?.value.toLowerCase();
  if (contentType?.includes("application/x-www-form-urlencoded")) {
    return {
      kind: "urlencoded",
      entries: [...new URLSearchParams(text)].map(([name, value]) => ({
        name,
        value,
        enabled: true,
      })),
    };
  }
  if (contentType?.includes("json") || looksLikeJson(text)) {
    return { kind: "json", text, mediaType: contentType };
  }
  return { kind: "text", text, mediaType: contentType };
}

export function looksLikeJson(text: string): boolean {
  const value = text.trim();
  if (!(value.startsWith("{") || value.startsWith("["))) return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

export function safeId(prefix = "request"): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function powerShellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function jsonString(value: string): string {
  return JSON.stringify(value);
}

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64Utf8(value: string): string | undefined {
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function normalizeMethod(method: string | undefined): string {
  return (method || "GET").trim().toUpperCase();
}

export function splitUrlQuery(rawUrl: string): {
  url: string;
  query: KeyValueItem[];
} {
  try {
    const url = new URL(rawUrl);
    const query = [...url.searchParams].map(([name, value]) => ({
      name,
      value,
      enabled: true,
    }));
    url.search = "";
    return { url: url.toString(), query };
  } catch {
    return { url: rawUrl, query: [] };
  }
}
