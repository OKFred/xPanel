import { parse } from "acorn";
import type {
  ImportWarning,
  KeyValueItem,
  MultipartPart,
  RequestSpecV1,
} from "@xpanel/contracts";

import {
  detectBody,
  extractStructuredAuth,
  isRecord,
  jsonString,
  makeRequest,
  materializeAuth,
  prepareRequestForExport,
  normalizeMethod,
  requestUrl,
  safeId,
  splitUrlQuery,
  warning,
} from "./common.js";
import type { RequestParseResult } from "./curl.js";

interface AstNode {
  type: string;
  [key: string]: unknown;
}

interface FetchContext {
  strings: Map<string, string>;
  jsonValues: Map<string, unknown>;
  forms: Map<string, MultipartPart[]>;
  files: Map<string, RequestSpecV1["body"] & { kind: "file" }>;
  warnings: ImportWarning[];
}

export function parseNodeFetch(input: string): RequestParseResult {
  const warnings: ImportWarning[] = [];
  let root: AstNode;
  try {
    root = parse(input, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
    }) as unknown as AstNode;
  } catch (error) {
    return {
      requests: [],
      warnings: [
        warning(
          "fetch.syntax_invalid",
          `JavaScript could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ],
    };
  }

  const context: FetchContext = {
    strings: new Map(),
    jsonValues: new Map(),
    forms: new Map(),
    files: new Map(),
    warnings,
  };
  collectStaticBindings(root, context);
  collectFormAppends(root, context);
  const calls: AstNode[] = [];
  walkAst(root, (node) => {
    if (node.type === "CallExpression" && isFetchCallee(asNode(node.callee))) {
      calls.push(node);
    }
  });
  if (calls.length === 0) {
    warnings.push(warning("fetch.call_missing", "No fetch() call was found."));
  }

  const requests: RequestSpecV1[] = [];
  for (const [index, call] of calls.entries()) {
    const args = asNodes(call.arguments);
    const rawUrl = staticString(args[0], context);
    if (!rawUrl) {
      warnings.push(
        warning(
          "fetch.url_dynamic",
          `fetch() call ${index + 1} has no static URL and was skipped.`,
        ),
      );
      continue;
    }
    const options = args[1]?.type === "ObjectExpression" ? args[1] : undefined;
    if (args[1] && !options) {
      warnings.push(
        warning(
          "fetch.options_dynamic",
          "Only an inline static fetch options object is imported.",
        ),
      );
    }
    const method = staticString(propertyValue(options, "method"), context);
    const headers = parseHeaders(propertyValue(options, "headers"), context);
    const bodyNode = propertyValue(options, "body");
    const body = parseFetchBody(bodyNode, headers, context);
    const split = splitUrlQuery(rawUrl);
    const extracted = extractStructuredAuth(headers, split.query);
    requests.push(
      makeRequest(
        { format: "fetch" },
        {
          name: `Imported fetch ${index + 1}`,
          method: method
            ? normalizeMethod(method)
            : body.kind === "none"
              ? "GET"
              : "POST",
          url: split.url,
          query: extracted.query,
          headers: extracted.headers,
          auth: extracted.auth,
          body,
          options: {
            redirect:
              staticString(propertyValue(options, "redirect"), context) ===
              "manual"
                ? "manual"
                : staticString(propertyValue(options, "redirect"), context) ===
                    "error"
                  ? "error"
                  : "follow",
            cookieMode:
              staticString(propertyValue(options, "credentials"), context) ===
              "omit"
                ? "omit"
                : staticString(
                      propertyValue(options, "credentials"),
                      context,
                    ) === "same-origin"
                  ? "same-origin"
                  : "include",
            timeoutMs: 30_000,
            proxy: null,
            tls: { verify: true },
          },
          warnings,
        },
      ),
    );
  }
  return { requests, warnings };
}

export function exportNodeFetch(
  input: RequestSpecV1,
  options: { includeSensitive?: boolean } = {},
): { text: string; warnings: ImportWarning[] } {
  const prepared = prepareRequestForExport(input, options.includeSensitive);
  const request = materializeAuth(prepared.request);
  const warnings: ImportWarning[] = [...prepared.warnings];
  const prefix: string[] = [];
  let bodyExpression: string | undefined;
  switch (request.body.kind) {
    case "none":
      break;
    case "json": {
      try {
        bodyExpression = `JSON.stringify(${JSON.stringify(JSON.parse(request.body.text), null, 2)})`;
      } catch {
        bodyExpression = jsonString(request.body.text);
        warnings.push(
          warning(
            "fetch.invalid_json_exported_as_text",
            "The JSON body is invalid and was exported as a string literal.",
          ),
        );
      }
      break;
    }
    case "text":
      bodyExpression = jsonString(request.body.text);
      break;
    case "urlencoded": {
      const record = Object.fromEntries(
        request.body.entries
          .filter((entry) => entry.enabled !== false)
          .map((entry) => [entry.name, entry.value]),
      );
      bodyExpression = `new URLSearchParams(${JSON.stringify(record, null, 2)})`;
      break;
    }
    case "multipart":
      prefix.push("const form = new FormData()");
      for (const part of request.body.parts.filter(
        (item) => item.enabled !== false,
      )) {
        if (part.kind === "text") {
          prefix.push(
            `form.append(${jsonString(part.name)}, ${jsonString(part.value)})`,
          );
        } else {
          prefix.push(
            `form.append(${jsonString(part.name)}, new Blob([]), ${jsonString(part.file.name)})`,
          );
          warnings.push(
            warning(
              "export.file_reselection_required",
              `A zero-byte placeholder was generated for ${part.file.name}; reselect the file before sending.`,
            ),
          );
        }
      }
      bodyExpression = "form";
      break;
    case "file":
      prefix.push(
        `const bodyFile = new File([], ${jsonString(request.body.file.name)}${
          request.body.mediaType
            ? `, { type: ${jsonString(request.body.mediaType)} }`
            : ""
        })`,
      );
      bodyExpression = "bodyFile";
      warnings.push(
        warning(
          "export.file_reselection_required",
          `A zero-byte placeholder was generated for ${request.body.file.name}; reselect the file before sending.`,
        ),
      );
      break;
  }

  const headers = Object.fromEntries(
    request.headers
      .filter((header) => header.enabled !== false)
      .map((header) => [header.name, header.value]),
  );
  const properties = [
    `method: ${jsonString(request.method)}`,
    `headers: ${JSON.stringify(headers, null, 2)}`,
    `redirect: ${jsonString(request.options.redirect)}`,
    `credentials: ${jsonString(request.options.cookieMode)}`,
  ];
  if (bodyExpression) properties.push(`body: ${bodyExpression}`);
  const code = `const response = await fetch(${jsonString(requestUrl(request))}, {\n${properties
    .map((property) => `  ${property.replaceAll("\n", "\n  ")}`)
    .join(",\n")}\n})`;
  return { text: [...prefix, code].join("\n\n"), warnings };
}

function collectStaticBindings(root: AstNode, context: FetchContext): void {
  walkAst(root, (node) => {
    if (node.type !== "VariableDeclarator") return;
    const id = asNode(node.id);
    const init = asNode(node.init);
    if (id?.type !== "Identifier" || !init) return;
    const name = String(id.name);
    const string = staticString(init, context);
    if (string !== undefined) context.strings.set(name, string);
    const json = staticJson(init, context);
    if (json !== undefined) context.jsonValues.set(name, json);
    if (isNewExpression(init, "FormData")) context.forms.set(name, []);
    const fileBody = fileBodyFromNode(init, context);
    if (fileBody) context.files.set(name, fileBody);
  });
}

function collectFormAppends(root: AstNode, context: FetchContext): void {
  walkAst(root, (node) => {
    if (node.type !== "CallExpression") return;
    const callee = asNode(node.callee);
    if (callee?.type !== "MemberExpression") return;
    const object = asNode(callee.object);
    const property = asNode(callee.property);
    if (
      object?.type !== "Identifier" ||
      staticPropertyName(property) !== "append" ||
      !context.forms.has(String(object.name))
    ) {
      return;
    }
    const args = asNodes(node.arguments);
    const name = staticString(args[0], context);
    const value = staticString(args[1], context);
    if (!name) {
      context.warnings.push(
        warning(
          "fetch.form_dynamic",
          "Skipped a FormData append with a dynamic name.",
        ),
      );
      return;
    }
    const parts = context.forms.get(String(object.name)) ?? [];
    if (value !== undefined) {
      parts.push({ kind: "text", name, value, enabled: true });
    } else if (
      isNewExpression(args[1], "Blob") ||
      isNewExpression(args[1], "File")
    ) {
      const fileName = staticString(args[2], context) ?? "file";
      parts.push({
        kind: "file",
        name,
        enabled: true,
        file: {
          id: safeId("file"),
          name: fileName,
          requiresReselection: true,
        },
      });
      context.warnings.push(
        warning(
          "fetch.file_reselection_required",
          `File ${fileName} must be selected again.`,
        ),
      );
    } else {
      context.warnings.push(
        warning(
          "fetch.form_dynamic",
          `Skipped dynamic FormData value for ${name}.`,
        ),
      );
    }
    context.forms.set(String(object.name), parts);
  });
}

function parseHeaders(
  node: AstNode | undefined,
  context: FetchContext,
): KeyValueItem[] {
  if (!node) return [];
  if (node.type === "Identifier") {
    const value = context.jsonValues.get(String(node.name));
    return isRecord(value)
      ? Object.entries(value).map(([name, item]) => ({
          name,
          value: String(item),
          enabled: true,
        }))
      : [];
  }
  if (isNewExpression(node, "Headers")) {
    return parseHeaders(asNodes(node.arguments)[0], context);
  }
  const object = staticJson(node, context);
  if (isRecord(object)) {
    return Object.entries(object).map(([name, value]) => ({
      name,
      value: String(value),
      enabled: true,
    }));
  }
  if (Array.isArray(object)) {
    return object.flatMap((pair) =>
      Array.isArray(pair) && pair.length >= 2
        ? [{ name: String(pair[0]), value: String(pair[1]), enabled: true }]
        : [],
    );
  }
  context.warnings.push(
    warning("fetch.headers_dynamic", "Only static fetch headers are imported."),
  );
  return [];
}

function parseFetchBody(
  node: AstNode | undefined,
  headers: KeyValueItem[],
  context: FetchContext,
): RequestSpecV1["body"] {
  if (!node) return { kind: "none" };
  if (node.type === "Identifier" && context.forms.has(String(node.name))) {
    return {
      kind: "multipart",
      parts: context.forms.get(String(node.name)) ?? [],
    };
  }
  if (node.type === "Identifier" && context.files.has(String(node.name))) {
    return context.files.get(String(node.name))!;
  }
  const directFile = fileBodyFromNode(node, context);
  if (directFile) return directFile;
  if (isNewExpression(node, "URLSearchParams")) {
    const value = staticJson(asNodes(node.arguments)[0], context);
    const entries = isRecord(value)
      ? Object.entries(value).map(([name, item]) => ({
          name,
          value: String(item),
          enabled: true,
        }))
      : typeof value === "string"
        ? [...new URLSearchParams(value)].map(([name, item]) => ({
            name,
            value: item,
            enabled: true,
          }))
        : [];
    return { kind: "urlencoded", entries };
  }
  if (node.type === "CallExpression") {
    const callee = asNode(node.callee);
    if (
      callee?.type === "MemberExpression" &&
      asNode(callee.object)?.type === "Identifier" &&
      String(asNode(callee.object)?.name) === "JSON" &&
      staticPropertyName(asNode(callee.property)) === "stringify"
    ) {
      const value = staticJson(asNodes(node.arguments)[0], context);
      if (value !== undefined) {
        return {
          kind: "json",
          text: JSON.stringify(value),
          mediaType: "application/json",
        };
      }
    }
  }
  const value = staticString(node, context);
  if (value !== undefined) return detectBody(value, headers);
  context.warnings.push(
    warning("fetch.body_dynamic", "The dynamic fetch body was not evaluated."),
  );
  return { kind: "none" };
}

function fileBodyFromNode(
  node: AstNode | undefined,
  context: FetchContext,
): (RequestSpecV1["body"] & { kind: "file" }) | undefined {
  if (!isNewExpression(node, "File") && !isNewExpression(node, "Blob")) {
    return undefined;
  }
  const args = asNodes(node?.arguments);
  const name = isNewExpression(node, "File")
    ? (staticString(args[1], context) ?? "body.bin")
    : "body.bin";
  const optionNode = args[2];
  const mediaType = staticString(propertyValue(optionNode, "type"), context);
  context.warnings.push(
    warning(
      "fetch.file_reselection_required",
      `File body ${name} must be selected again.`,
    ),
  );
  return {
    kind: "file",
    file: {
      id: safeId("body"),
      name,
      requiresReselection: true,
    },
    ...(mediaType ? { mediaType } : {}),
  };
}

function staticString(
  node: AstNode | undefined,
  context: FetchContext,
): string | undefined {
  if (!node) return undefined;
  if (node.type === "Literal" && typeof node.value === "string")
    return node.value;
  if (node.type === "TemplateLiteral") {
    const expressions = asNodes(node.expressions);
    const quasis = asNodes(node.quasis);
    if (expressions.length === 0) {
      const value = asNode(quasis[0]?.value);
      return typeof value?.cooked === "string" ? value.cooked : undefined;
    }
    context.warnings.push(
      warning(
        "fetch.template_dynamic",
        "Template expressions are not evaluated.",
      ),
    );
    return undefined;
  }
  if (node.type === "Identifier") return context.strings.get(String(node.name));
  return undefined;
}

function staticJson(node: AstNode | undefined, context: FetchContext): unknown {
  if (!node) return undefined;
  if (node.type === "Literal") return node.value;
  if (node.type === "Identifier") {
    if (node.name === "true") return true;
    if (node.name === "false") return false;
    if (node.name === "null") return null;
    return context.jsonValues.get(String(node.name));
  }
  if (node.type === "TemplateLiteral") return staticString(node, context);
  if (node.type === "ObjectExpression") {
    const result: Record<string, unknown> = {};
    for (const property of asNodes(node.properties)) {
      if (property.type !== "Property" || property.computed === true)
        return undefined;
      const key = staticPropertyName(asNode(property.key));
      if (!key) return undefined;
      const value = staticJson(asNode(property.value), context);
      if (value === undefined) return undefined;
      result[key] = value;
    }
    return result;
  }
  if (node.type === "ArrayExpression") {
    const values = asNodes(node.elements).map((item) =>
      staticJson(item, context),
    );
    return values.some((value) => value === undefined) ? undefined : values;
  }
  if (node.type === "UnaryExpression" && node.operator === "-") {
    const value = staticJson(asNode(node.argument), context);
    return typeof value === "number" ? -value : undefined;
  }
  return undefined;
}

function propertyValue(
  object: AstNode | undefined,
  name: string,
): AstNode | undefined {
  if (object?.type !== "ObjectExpression") return undefined;
  for (const property of asNodes(object.properties)) {
    if (
      property.type === "Property" &&
      staticPropertyName(asNode(property.key)) === name
    ) {
      return asNode(property.value);
    }
  }
  return undefined;
}

function staticPropertyName(node: AstNode | undefined): string | undefined {
  if (node?.type === "Identifier") return String(node.name);
  if (node?.type === "Literal" && typeof node.value === "string")
    return node.value;
  return undefined;
}

function isFetchCallee(node: AstNode | undefined): boolean {
  if (node?.type === "Identifier" && node.name === "fetch") return true;
  return (
    node?.type === "MemberExpression" &&
    asNode(node.object)?.type === "Identifier" &&
    ["globalThis", "window"].includes(String(asNode(node.object)?.name)) &&
    staticPropertyName(asNode(node.property)) === "fetch"
  );
}

function isNewExpression(
  node: AstNode | undefined,
  calleeName: string,
): boolean {
  return (
    node?.type === "NewExpression" &&
    asNode(node.callee)?.type === "Identifier" &&
    asNode(node.callee)?.name === calleeName
  );
}

function asNode(value: unknown): AstNode | undefined {
  return isRecord(value) && typeof value.type === "string"
    ? (value as AstNode)
    : undefined;
}

function asNodes(value: unknown): AstNode[] {
  return Array.isArray(value)
    ? value.flatMap((item) => asNode(item) ?? [])
    : [];
}

function walkAst(node: AstNode, visit: (node: AstNode) => void): void {
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "start" || key === "end" || key === "loc") continue;
    const child = asNode(value);
    if (child) walkAst(child, visit);
    else if (Array.isArray(value)) {
      for (const item of value) {
        const nested = asNode(item);
        if (nested) walkAst(nested, visit);
      }
    }
  }
}
