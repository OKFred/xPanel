import { parse as parseYaml } from "yaml";
import {
  authSpecSchema,
  redactRequestForExport,
  redactResponseForExport,
  type AuthSpec,
  type ImportWarning,
  type KeyValueItem,
  type MultipartPart,
  type RequestSpecV1,
  type ResponseRecordV1,
} from "@xpanel/contracts";

import { asString, isRecord, makeRequest, safeId, warning } from "./common.js";
import type { ImportOptions, OpenApiDocumentExport } from "./types.js";

const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;

interface OpenApiImportResult {
  format: "openapi" | "swagger";
  requests: RequestSpecV1[];
  warnings: ImportWarning[];
}

interface OpenApiExportOptions {
  includeSensitive?: boolean;
  title?: string;
  responses?: ResponseRecordV1[];
  version?: "3.0.3" | "3.1.0" | "3.2.0" | "2.0";
}

export async function importOpenApi(
  input: string | object,
  options: ImportOptions = {},
): Promise<OpenApiImportResult> {
  const warnings: ImportWarning[] = [];
  let document: Record<string, unknown>;
  try {
    const parsed: unknown =
      typeof input === "string" ? (parseYaml(input) as unknown) : input;
    if (!isRecord(parsed)) throw new Error("The root value must be an object.");
    document = parsed;
  } catch (error) {
    return {
      format: "openapi",
      requests: [],
      warnings: [
        warning(
          "openapi.parse_failed",
          `OpenAPI/Swagger document could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ],
    };
  }

  const isSwagger = document.swagger === "2.0";
  const version = asString(document.openapi);
  if (!isSwagger && !/^3\.(?:0|1|2)(?:\.|$)/.test(version ?? "")) {
    warnings.push(
      warning(
        "openapi.version_unsupported",
        `Expected Swagger 2.0 or OpenAPI 3.0/3.1/3.2, received ${version ?? "an unknown version"}.`,
      ),
    );
    return { format: "openapi", requests: [], warnings };
  }

  const resolver = new ReferenceResolver(document, options, warnings);
  const requests = isSwagger
    ? await importSwaggerDocument(document, resolver, warnings)
    : await importOpenApiDocument(document, resolver, warnings);
  return { format: isSwagger ? "swagger" : "openapi", requests, warnings };
}

async function importOpenApiDocument(
  document: Record<string, unknown>,
  resolver: ReferenceResolver,
  warnings: ImportWarning[],
): Promise<RequestSpecV1[]> {
  const rootServers = arrayRecords(document.servers);
  const paths = isRecord(document.paths) ? document.paths : {};
  const requests: RequestSpecV1[] = [];

  for (const [path, rawPathItem] of Object.entries(paths)) {
    const pathItem = await resolver.record(rawPathItem, resolver.baseUrl, [
      `paths.${path}`,
    ]);
    if (!pathItem) continue;
    const pathItemBase = resolver.baseOf(pathItem);
    for (const method of HTTP_METHODS) {
      const operation = await resolver.record(pathItem[method], pathItemBase, [
        `paths.${path}.${method}`,
      ]);
      if (!operation) continue;
      const operationBase = resolver.baseOf(operation, pathItemBase);
      const operationWarnings: ImportWarning[] = [];
      const servers = arrayRecords(operation.servers).length
        ? arrayRecords(operation.servers)
        : arrayRecords(pathItem.servers).length
          ? arrayRecords(pathItem.servers)
          : rootServers;
      const baseUrl = expandServerUrl(
        asString(servers[0]?.url) ?? "http://localhost",
      );
      const parameters = [
        ...arrayValues(pathItem.parameters).map((raw) => ({
          raw,
          base: pathItemBase,
        })),
        ...arrayValues(operation.parameters).map((raw) => ({
          raw,
          base: operationBase,
        })),
      ];
      const query: KeyValueItem[] = [];
      const headers: KeyValueItem[] = [];
      let renderedPath = path;
      for (const [parameterIndex, parameterInput] of parameters.entries()) {
        const parameter = await resolver.record(
          parameterInput.raw,
          parameterInput.base,
          [`paths.${path}.${method}.parameters.${parameterIndex}`],
        );
        if (!parameter) continue;
        const name = asString(parameter.name);
        const location = asString(parameter.in);
        if (!name || !location) continue;
        const parameterBase = resolver.baseOf(parameter, parameterInput.base);
        const value = await parameterExample(
          parameter,
          resolver,
          parameterBase,
          operationWarnings,
          `paths.${path}.${method}.parameters.${parameterIndex}`,
        );
        if (value === undefined) {
          operationWarnings.push(
            warning(
              "openapi.parameter_placeholder",
              `Parameter ${name} has no example; a placeholder was kept.`,
              `paths.${path}.${method}.parameters.${parameterIndex}`,
            ),
          );
        }
        const text =
          value === undefined ? `{${name}}` : stringifyExample(value);
        if (location === "path")
          renderedPath = renderedPath.replaceAll(
            `{${name}}`,
            encodeURIComponent(text),
          );
        else if (location === "query")
          query.push({ name, value: text, enabled: true });
        else if (location === "header")
          headers.push({ name, value: text, enabled: true });
      }

      const body = await openApiRequestBody(
        operation.requestBody,
        resolver,
        operationWarnings,
        `paths.${path}.${method}.requestBody`,
        operationBase,
      );
      if (body.kind === "json" && !hasHeader(headers, "content-type")) {
        headers.push({
          name: "Content-Type",
          value: body.mediaType ?? "application/json",
          enabled: true,
        });
      }
      requests.push(
        makeRequest(
          { format: "openapi", label: asString(operation.operationId) },
          {
            name:
              asString(operation.summary) ??
              asString(operation.operationId) ??
              `${method.toUpperCase()} ${path}`,
            method: method.toUpperCase(),
            url: joinUrl(baseUrl, renderedPath),
            query,
            headers,
            auth: openApiAuth(document, operation),
            body,
            warnings: operationWarnings,
          },
        ),
      );
      warnings.push(...operationWarnings);
    }
  }
  return requests;
}

async function importSwaggerDocument(
  document: Record<string, unknown>,
  resolver: ReferenceResolver,
  warnings: ImportWarning[],
): Promise<RequestSpecV1[]> {
  const scheme =
    arrayValues(document.schemes).find((value) => typeof value === "string") ??
    "http";
  const host = asString(document.host) ?? "localhost";
  const basePath = asString(document.basePath) ?? "";
  const paths = isRecord(document.paths) ? document.paths : {};
  const requests: RequestSpecV1[] = [];

  for (const [path, rawPathItem] of Object.entries(paths)) {
    const pathItem = await resolver.record(rawPathItem, resolver.baseUrl, [
      `paths.${path}`,
    ]);
    if (!pathItem) continue;
    const pathItemBase = resolver.baseOf(pathItem);
    for (const method of HTTP_METHODS) {
      const operation = await resolver.record(pathItem[method], pathItemBase, [
        `paths.${path}.${method}`,
      ]);
      if (!operation) continue;
      const operationBase = resolver.baseOf(operation, pathItemBase);
      const operationWarnings: ImportWarning[] = [];
      const parameters = [
        ...arrayValues(pathItem.parameters).map((raw) => ({
          raw,
          base: pathItemBase,
        })),
        ...arrayValues(operation.parameters).map((raw) => ({
          raw,
          base: operationBase,
        })),
      ];
      const query: KeyValueItem[] = [];
      const headers: KeyValueItem[] = [];
      const formEntries: KeyValueItem[] = [];
      const multipartParts: MultipartPart[] = [];
      let renderedPath = path;
      let body: RequestSpecV1["body"] = { kind: "none" };
      for (const [index, parameterInput] of parameters.entries()) {
        const parameter = await resolver.record(
          parameterInput.raw,
          parameterInput.base,
          [`paths.${path}.${method}.parameters.${index}`],
        );
        if (!parameter) continue;
        const name = asString(parameter.name);
        const location = asString(parameter.in);
        if (!name || !location) continue;
        const parameterBase = resolver.baseOf(parameter, parameterInput.base);
        const example = await parameterExample(
          parameter,
          resolver,
          parameterBase,
          operationWarnings,
          `paths.${path}.${method}.parameters.${index}`,
        );
        const text =
          example === undefined ? `{${name}}` : stringifyExample(example);
        if (location === "path")
          renderedPath = renderedPath.replaceAll(
            `{${name}}`,
            encodeURIComponent(text),
          );
        else if (location === "query")
          query.push({ name, value: text, enabled: true });
        else if (location === "header")
          headers.push({ name, value: text, enabled: true });
        else if (location === "body") {
          const bodySchema =
            (await resolver.record(parameter.schema, parameterBase, [
              `paths.${path}.${method}.parameters.${index}.schema`,
            ])) ?? {};
          const mediaType =
            firstString(operation.consumes) ??
            firstString(document.consumes) ??
            "application/json";
          if (bodySchema.type === "string" && bodySchema.format === "binary") {
            body = {
              kind: "file",
              file: {
                id: safeId("body"),
                name: `${name}.bin`,
                mediaType,
                requiresReselection: true,
              },
              mediaType,
            };
          } else {
            const value = await schemaExample(
              parameter.schema,
              resolver,
              parameterBase,
              operationWarnings,
              `paths.${path}.${method}.parameters.${index}.schema`,
            );
            body = {
              kind: "json",
              text: JSON.stringify(value ?? {}, null, 2),
              mediaType,
            };
          }
        } else if (location === "formData" && parameter.type === "file") {
          multipartParts.push({
            kind: "file",
            name,
            enabled: true,
            file: {
              id: safeId("file"),
              name: `${name}.bin`,
              requiresReselection: true,
            },
          });
        } else if (location === "formData") {
          formEntries.push({ name, value: text, enabled: true });
        }
      }
      const consumes =
        firstString(operation.consumes) ?? firstString(document.consumes);
      if (multipartParts.length) {
        body = {
          kind: "multipart",
          parts: [
            ...formEntries.map(
              (entry): MultipartPart => ({
                kind: "text",
                name: entry.name,
                value: entry.value,
                enabled: entry.enabled,
              }),
            ),
            ...multipartParts,
          ],
        };
      } else if (formEntries.length) {
        body = { kind: "urlencoded", entries: formEntries };
      }
      if (consumes && !hasHeader(headers, "content-type")) {
        headers.push({ name: "Content-Type", value: consumes, enabled: true });
      }
      requests.push(
        makeRequest(
          { format: "swagger", label: asString(operation.operationId) },
          {
            name:
              asString(operation.summary) ??
              asString(operation.operationId) ??
              `${method.toUpperCase()} ${path}`,
            method: method.toUpperCase(),
            url: joinUrl(
              `${String(scheme)}://${host}${basePath}`,
              renderedPath,
            ),
            query,
            headers,
            auth: swaggerAuth(document, operation),
            body,
            warnings: operationWarnings,
          },
        ),
      );
      warnings.push(...operationWarnings);
    }
  }
  return requests;
}

async function openApiRequestBody(
  raw: unknown,
  resolver: ReferenceResolver,
  warnings: ImportWarning[],
  path: string,
  currentBase: string,
): Promise<RequestSpecV1["body"]> {
  const requestBody = await resolver.record(raw, currentBase, [path]);
  if (!requestBody) return { kind: "none" };
  const requestBodyBase = resolver.baseOf(requestBody, currentBase);
  const content = isRecord(requestBody.content) ? requestBody.content : {};
  const preferred =
    [
      "application/json",
      "application/x-www-form-urlencoded",
      "multipart/form-data",
    ].find((mediaType) => mediaType in content) ?? Object.keys(content)[0];
  if (!preferred) return { kind: "none" };
  const media = isRecord(content[preferred]) ? content[preferred] : {};
  const mediaSchema =
    (await resolver.record(media.schema, requestBodyBase, [
      `${path}.content.${preferred}.schema`,
    ])) ?? {};
  const schemaBase = resolver.baseOf(mediaSchema, requestBodyBase);
  if (mediaSchema.type === "string" && mediaSchema.format === "binary") {
    return {
      kind: "file",
      file: {
        id: safeId("body"),
        name: "body.bin",
        mediaType: preferred,
        requiresReselection: true,
      },
      mediaType: preferred,
    };
  }
  const example =
    media.example ??
    (await schemaExample(
      media.schema,
      resolver,
      requestBodyBase,
      warnings,
      `${path}.content.${preferred}.schema`,
    ));
  if (preferred === "application/x-www-form-urlencoded") {
    return {
      kind: "urlencoded",
      entries: isRecord(example)
        ? Object.entries(example).map(([name, value]) => ({
            name,
            value: stringifyExample(value),
            enabled: true,
          }))
        : [],
    };
  }
  if (preferred === "multipart/form-data") {
    const properties = isRecord(mediaSchema.properties)
      ? mediaSchema.properties
      : {};
    const parts: MultipartPart[] = [];
    for (const [name, rawProperty] of Object.entries(properties)) {
      const property =
        (await resolver.record(rawProperty, schemaBase, [
          `${path}.content.${preferred}.schema.properties.${name}`,
        ])) ?? {};
      if (property.format === "binary") {
        const mediaType = asString(property.contentMediaType);
        parts.push({
          kind: "file",
          name,
          enabled: true,
          file: {
            id: safeId("file"),
            name: `${name}.bin`,
            ...(mediaType ? { mediaType } : {}),
            requiresReselection: true,
          },
        });
        continue;
      }
      const propertyExample = isRecord(example) ? example[name] : undefined;
      parts.push({
        kind: "text",
        name,
        value: stringifyExample(
          propertyExample ??
            (await schemaExample(
              rawProperty,
              resolver,
              schemaBase,
              warnings,
              `${path}.content.${preferred}.schema.properties.${name}`,
            )) ??
            "",
        ),
        enabled: true,
      });
    }
    return {
      kind: "multipart",
      parts,
    };
  }
  if (example === undefined) {
    warnings.push(
      warning(
        "openapi.body_example_missing",
        "The request body schema had no example; an empty value was generated.",
        path,
      ),
    );
  }
  if (/json/i.test(preferred)) {
    return {
      kind: "json",
      text: JSON.stringify(example ?? {}, null, 2),
      mediaType: preferred,
    };
  }
  return {
    kind: "text",
    text: stringifyExample(example ?? ""),
    mediaType: preferred,
  };
}

export function exportOpenApi(
  inputs: RequestSpecV1[],
  options: OpenApiExportOptions = {},
): OpenApiDocumentExport {
  const version = options.version ?? "3.1.0";
  const groups = new Map<string, RequestSpecV1[]>();
  const warnings: ImportWarning[] = [];
  const exportResponses = (options.responses ?? []).map((response, index) => {
    if (options.includeSensitive) return structuredClone(response);
    const prepared = redactResponseForExport(response);
    warnings.push(
      ...prepared.warnings.map((item) => ({
        ...item,
        path: item.path
          ? `responses.${index}.${item.path}`
          : `responses.${index}`,
      })),
    );
    return prepared.value;
  });
  const preparedOptions: OpenApiExportOptions = {
    ...options,
    responses: exportResponses,
  };
  for (const [index, input] of inputs.entries()) {
    const prepared = options.includeSensitive
      ? { value: structuredClone(input), warnings: [] }
      : redactRequestForExport(input);
    warnings.push(
      ...prepared.warnings.map((item) => ({
        ...item,
        path: item.path
          ? `requests.${index}.${item.path}`
          : `requests.${index}`,
      })),
    );
    const request = prepared.value;
    let origin = "http://localhost";
    try {
      origin = new URL(request.url).origin;
    } catch {
      warnings.push(
        warning(
          "openapi.url_invalid",
          `Request ${request.name} has an invalid URL and was grouped under localhost.`,
        ),
      );
    }
    groups.set(origin, [...(groups.get(origin) ?? []), request]);
  }
  const documents: Record<string, Record<string, unknown>> = {};
  for (const [origin, requests] of groups) {
    const key = originFileName(
      origin,
      version === "2.0" ? "swagger" : "openapi",
    );
    documents[key] =
      version === "2.0"
        ? buildSwaggerDocument(origin, requests, preparedOptions, warnings)
        : buildOpenApiDocument(
            origin,
            requests,
            version,
            preparedOptions,
            warnings,
          );
  }
  return { format: "openapi", documents, warnings };
}

export function exportSwagger(
  inputs: RequestSpecV1[],
  options: Omit<OpenApiExportOptions, "version"> = {},
): OpenApiDocumentExport {
  return exportOpenApi(inputs, { ...options, version: "2.0" });
}

function buildOpenApiDocument(
  origin: string,
  requests: RequestSpecV1[],
  version: "3.0.3" | "3.1.0" | "3.2.0",
  options: OpenApiExportOptions,
  warnings: ImportWarning[],
): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const securitySchemes: Record<string, unknown> = {};
  for (const request of requests) {
    const url = safeUrl(request.url, origin);
    const path = url.pathname || "/";
    const method = request.method.toLowerCase();
    paths[path] ??= {};
    if (paths[path][method]) {
      warnings.push(
        warning(
          "openapi.operation_collision",
          `${request.method} ${path} replaced an earlier generated operation.`,
        ),
      );
    }
    const parameters = [
      ...request.query
        .filter((item) => item.enabled !== false)
        .map((item) => parameterFromEntry(item, "query")),
      ...request.headers
        .filter(
          (item) =>
            item.enabled !== false &&
            item.name.toLowerCase() !== "content-type",
        )
        .map((item) => parameterFromEntry(item, "header")),
      ...pathParameters(path),
    ];
    const operation: Record<string, unknown> = {
      summary: request.name,
      operationId: safeOperationId(request),
      ...(parameters.length ? { parameters } : {}),
      responses: buildOpenApiResponses(request, options.responses ?? []),
      "x-xpanel-generated": true,
      "x-xpanel-auth": request.auth,
    };
    const security = addOpenApiSecurity(request.auth, securitySchemes);
    if (security) operation.security = [security];
    const requestBody = openApiBodyFromRequest(request);
    if (requestBody) operation.requestBody = requestBody;
    paths[path][method] = operation;
  }
  return {
    openapi: version,
    info: {
      title: options.title ?? "xPanel generated API",
      version: "1.0.0",
      description: "Generated by xPanel. This conversion may be lossy.",
    },
    servers: [{ url: origin }],
    paths,
    ...(Object.keys(securitySchemes).length
      ? { components: { securitySchemes } }
      : {}),
    "x-xpanel-generated": true,
  };
}

function buildSwaggerDocument(
  origin: string,
  requests: RequestSpecV1[],
  options: OpenApiExportOptions,
  warnings: ImportWarning[],
): Record<string, unknown> {
  const originUrl = safeUrl(origin, "http://localhost");
  const paths: Record<string, Record<string, unknown>> = {};
  const securityDefinitions: Record<string, unknown> = {};
  for (const request of requests) {
    const url = safeUrl(request.url, origin);
    const path = url.pathname || "/";
    const method = request.method.toLowerCase();
    paths[path] ??= {};
    if (paths[path][method]) {
      warnings.push(
        warning(
          "swagger.operation_collision",
          `${request.method} ${path} replaced an earlier generated operation.`,
        ),
      );
    }
    const parameters: Record<string, unknown>[] = [
      ...request.query
        .filter((item) => item.enabled !== false)
        .map((item) => ({
          name: item.name,
          in: "query",
          required: false,
          type: inferScalarType(item.value),
          default: item.value,
        })),
      ...request.headers
        .filter(
          (item) =>
            item.enabled !== false &&
            item.name.toLowerCase() !== "content-type",
        )
        .map((item) => ({
          name: item.name,
          in: "header",
          required: false,
          type: "string",
          default: item.value,
        })),
    ];
    const consumes: string[] = [];
    if (request.body.kind === "json" || request.body.kind === "text") {
      parameters.push({
        name: "body",
        in: "body",
        required: true,
        schema: schemaFromBody(request),
      });
      consumes.push(
        request.body.mediaType ??
          (request.body.kind === "json" ? "application/json" : "text/plain"),
      );
    } else if (request.body.kind === "file") {
      consumes.push(request.body.mediaType ?? "application/octet-stream");
      parameters.push({
        name: "body",
        in: "body",
        required: true,
        schema: { type: "string", format: "binary" },
      });
    } else if (request.body.kind === "urlencoded") {
      consumes.push("application/x-www-form-urlencoded");
      parameters.push(
        ...request.body.entries
          .filter((entry) => entry.enabled !== false)
          .map((entry) => ({
            name: entry.name,
            in: "formData",
            required: false,
            type: inferScalarType(entry.value),
            default: entry.value,
          })),
      );
    } else if (request.body.kind === "multipart") {
      consumes.push("multipart/form-data");
      parameters.push(
        ...request.body.parts
          .filter((part) => part.enabled !== false)
          .map((part) => ({
            name: part.name,
            in: "formData",
            required: false,
            type: part.kind === "file" ? "file" : "string",
            ...(part.kind === "text" ? { default: part.value } : {}),
          })),
      );
    }
    const generatedOperation: Record<string, unknown> = {
      summary: request.name,
      operationId: safeOperationId(request),
      parameters,
      ...(consumes.length ? { consumes } : {}),
      responses: buildSwaggerResponses(request, options.responses ?? []),
      "x-xpanel-generated": true,
      "x-xpanel-auth": request.auth,
    };
    const security = addSwaggerSecurity(request.auth, securityDefinitions);
    if (security) generatedOperation.security = [security];
    paths[path][method] = generatedOperation;
  }
  return {
    swagger: "2.0",
    info: {
      title: options.title ?? "xPanel generated API",
      version: "1.0.0",
      description: "Generated by xPanel. This conversion may be lossy.",
    },
    schemes: [originUrl.protocol.replace(":", "")],
    host: originUrl.host,
    basePath: "/",
    paths,
    ...(Object.keys(securityDefinitions).length ? { securityDefinitions } : {}),
    "x-xpanel-generated": true,
  };
}

function openApiBodyFromRequest(
  request: RequestSpecV1,
): Record<string, unknown> | undefined {
  if (request.body.kind === "none") return undefined;
  let mediaType = "text/plain";
  let schema: Record<string, unknown>;
  let example: unknown;
  if (request.body.kind === "json") {
    mediaType = request.body.mediaType ?? "application/json";
    try {
      example = JSON.parse(request.body.text);
    } catch {
      example = request.body.text;
    }
    schema = inferSchema(example);
  } else if (request.body.kind === "text") {
    mediaType = request.body.mediaType ?? "text/plain";
    example = request.body.text;
    schema = { type: "string" };
  } else if (request.body.kind === "file") {
    mediaType = request.body.mediaType ?? "application/octet-stream";
    schema = { type: "string", format: "binary" };
    example = undefined;
  } else if (request.body.kind === "urlencoded") {
    mediaType = "application/x-www-form-urlencoded";
    example = Object.fromEntries(
      request.body.entries
        .filter((item) => item.enabled !== false)
        .map((item) => [item.name, item.value]),
    );
    schema = inferSchema(example);
  } else {
    mediaType = "multipart/form-data";
    const properties: Record<string, unknown> = {};
    example = {};
    for (const part of request.body.parts.filter(
      (item) => item.enabled !== false,
    )) {
      properties[part.name] =
        part.kind === "file"
          ? { type: "string", format: "binary" }
          : inferSchema(part.value);
    }
    schema = { type: "object", properties };
  }
  return {
    required: true,
    content: { [mediaType]: { schema, example } },
  };
}

function buildOpenApiResponses(
  request: RequestSpecV1,
  responses: ResponseRecordV1[],
): Record<string, unknown> {
  const response = responses.find((item) => item.requestId === request.id);
  if (!response) return { default: { description: "Generated response" } };
  const body =
    response.body.kind === "inline" ? response.body.content : undefined;
  let example: unknown = body;
  if (body && /json/i.test(response.body.mediaType ?? "")) {
    try {
      example = JSON.parse(body);
    } catch {
      example = body;
    }
  }
  return {
    [String(response.status)]: {
      description: response.statusText || "Generated response",
      headers: Object.fromEntries(
        response.headers.map((header) => [
          header.name,
          { schema: { type: "string" }, example: header.value },
        ]),
      ),
      ...(body === undefined
        ? {}
        : {
            content: {
              [response.body.mediaType ?? "text/plain"]: {
                schema: inferSchema(example),
                example,
              },
            },
          }),
    },
  };
}

function buildSwaggerResponses(
  request: RequestSpecV1,
  responses: ResponseRecordV1[],
): Record<string, unknown> {
  const response = responses.find((item) => item.requestId === request.id);
  if (!response) return { 200: { description: "Generated response" } };
  const key = response.status > 0 ? String(response.status) : "default";
  const headers = Object.fromEntries(
    response.headers.map((header) => [
      header.name,
      { type: "string", default: header.value },
    ]),
  );
  if (response.body.kind === "transfer") {
    return {
      [key]: {
        description: response.statusText || "Generated response",
        headers,
      },
    };
  }
  let example: unknown = response.body.content;
  if (
    response.body.encoding === "utf8" &&
    /json/i.test(response.body.mediaType ?? "")
  ) {
    try {
      example = JSON.parse(response.body.content) as unknown;
    } catch {
      example = response.body.content;
    }
  }
  const schema =
    response.body.encoding === "base64"
      ? { type: "string", format: "byte" }
      : inferSchema(example);
  const mediaType = response.body.mediaType ?? "text/plain";
  return {
    [key]: {
      description: response.statusText || "Generated response",
      headers,
      schema,
      examples: { [mediaType]: example },
    },
  };
}

function openApiAuth(
  document: Record<string, unknown>,
  operation: Record<string, unknown>,
): AuthSpec {
  const extended = authSpecSchema.safeParse(operation["x-xpanel-auth"]);
  if (extended.success) return extended.data;
  const components = isRecord(document.components) ? document.components : {};
  const schemes = isRecord(components.securitySchemes)
    ? components.securitySchemes
    : {};
  const requirement = firstSecurityRequirement(
    operation.security ?? document.security,
  );
  if (!requirement) return { kind: "none" };
  const [name] = Object.keys(requirement);
  const scheme = name && isRecord(schemes[name]) ? schemes[name] : undefined;
  if (!name || !scheme) return { kind: "none" };
  if (scheme.type === "http" && scheme.scheme === "basic") {
    return { kind: "basic", username: "", password: "" };
  }
  if (scheme.type === "http" && scheme.scheme === "bearer") {
    return { kind: "bearer", token: "" };
  }
  if (scheme.type === "oauth2" || scheme.type === "openIdConnect") {
    return { kind: "oauth2", accessToken: "", tokenType: "Bearer" };
  }
  if (
    scheme.type === "apiKey" &&
    ["header", "query", "cookie"].includes(String(scheme.in)) &&
    typeof scheme.name === "string"
  ) {
    return {
      kind: "api-key",
      location: scheme.in as "header" | "query" | "cookie",
      name: scheme.name,
      value: "",
    };
  }
  return { kind: "none" };
}

function swaggerAuth(
  document: Record<string, unknown>,
  operation: Record<string, unknown>,
): AuthSpec {
  const extended = authSpecSchema.safeParse(operation["x-xpanel-auth"]);
  if (extended.success) return extended.data;
  const schemes = isRecord(document.securityDefinitions)
    ? document.securityDefinitions
    : {};
  const requirement = firstSecurityRequirement(
    operation.security ?? document.security,
  );
  if (!requirement) return { kind: "none" };
  const [name] = Object.keys(requirement);
  const scheme = name && isRecord(schemes[name]) ? schemes[name] : undefined;
  if (!name || !scheme) return { kind: "none" };
  if (scheme.type === "basic") {
    return { kind: "basic", username: "", password: "" };
  }
  if (
    scheme.type === "apiKey" &&
    ["header", "query"].includes(String(scheme.in)) &&
    typeof scheme.name === "string"
  ) {
    return {
      kind: "api-key",
      location: scheme.in as "header" | "query",
      name: scheme.name,
      value: "",
    };
  }
  if (scheme.type === "oauth2") {
    return { kind: "oauth2", accessToken: "", tokenType: "Bearer" };
  }
  return { kind: "none" };
}

function firstSecurityRequirement(
  value: unknown,
): Record<string, unknown> | undefined {
  return Array.isArray(value)
    ? value.find((item): item is Record<string, unknown> => isRecord(item))
    : undefined;
}

function addOpenApiSecurity(
  auth: AuthSpec,
  schemes: Record<string, unknown>,
): Record<string, never[]> | undefined {
  const name = securitySchemeName(auth);
  if (!name) return undefined;
  if (!(name in schemes)) {
    switch (auth.kind) {
      case "basic":
        schemes[name] = { type: "http", scheme: "basic" };
        break;
      case "bearer":
        schemes[name] = { type: "http", scheme: "bearer" };
        break;
      case "oauth2":
        schemes[name] = {
          type: "oauth2",
          flows: {
            clientCredentials: {
              tokenUrl: "https://example.invalid/token",
              scopes: {},
            },
          },
        };
        break;
      case "api-key":
        schemes[name] = {
          type: "apiKey",
          in: auth.location,
          name: auth.name,
        };
        break;
      case "none":
        return undefined;
    }
  }
  return { [name]: [] };
}

function addSwaggerSecurity(
  auth: AuthSpec,
  schemes: Record<string, unknown>,
): Record<string, never[]> | undefined {
  const name = securitySchemeName(auth);
  if (!name) return undefined;
  if (!(name in schemes)) {
    switch (auth.kind) {
      case "basic":
        schemes[name] = { type: "basic" };
        break;
      case "bearer":
        schemes[name] = {
          type: "apiKey",
          in: "header",
          name: "Authorization",
          description: "Use a Bearer token.",
        };
        break;
      case "oauth2":
        schemes[name] = {
          type: "oauth2",
          flow: "application",
          tokenUrl: "https://example.invalid/token",
          scopes: {},
        };
        break;
      case "api-key":
        schemes[name] = {
          type: "apiKey",
          in: auth.location === "cookie" ? "header" : auth.location,
          name: auth.location === "cookie" ? "Cookie" : auth.name,
        };
        break;
      case "none":
        return undefined;
    }
  }
  return { [name]: [] };
}

function securitySchemeName(auth: AuthSpec): string | undefined {
  switch (auth.kind) {
    case "none":
      return undefined;
    case "basic":
      return "xpanelBasic";
    case "bearer":
      return "xpanelBearer";
    case "oauth2":
      return "xpanelOAuth2";
    case "api-key":
      return `xpanelApiKey_${auth.name.replace(/[^A-Za-z0-9_]+/g, "_")}`;
  }
}

class ReferenceResolver {
  readonly baseUrl: string;
  private readonly options: ImportOptions;
  private readonly warnings: ImportWarning[];
  private readonly cache = new Map<string, Record<string, unknown>>();
  private readonly contexts = new WeakMap<object, string>();

  constructor(
    root: Record<string, unknown>,
    options: ImportOptions,
    warnings: ImportWarning[],
  ) {
    this.options = options;
    this.warnings = warnings;
    this.baseUrl = options.baseUrl ?? "file:///xpanel-import.yaml";
    const rootBase = stripFragment(this.baseUrl);
    this.cache.set(rootBase, root);
    this.contexts.set(root, rootBase);
  }

  baseOf(value: object, fallback = this.baseUrl): string {
    return this.contexts.get(value) ?? stripFragment(fallback);
  }

  get maxDepth(): number {
    return this.options.maxRefDepth ?? 24;
  }

  async record(
    value: unknown,
    currentBase: string,
    chain: string[],
  ): Promise<Record<string, unknown> | undefined> {
    if (!isRecord(value)) return undefined;
    const ref = asString(value.$ref);
    if (!ref) {
      this.contexts.set(value, stripFragment(currentBase));
      return value;
    }
    const maxDepth = this.maxDepth;
    if (chain.length >= maxDepth) {
      this.warnings.push(
        warning(
          "openapi.ref_depth",
          `Reference depth exceeded ${maxDepth}.`,
          chain.at(-1),
        ),
      );
      return undefined;
    }
    let absolute: string;
    try {
      absolute = new URL(ref, currentBase).toString();
    } catch {
      this.warnings.push(
        warning("openapi.ref_invalid", `Invalid reference: ${ref}`),
      );
      return undefined;
    }
    if (chain.includes(absolute)) {
      this.warnings.push(
        warning(
          "openapi.ref_cycle",
          `Reference cycle detected at ${absolute}.`,
        ),
      );
      return undefined;
    }
    const [documentUrl, fragment = ""] = splitReference(absolute);
    let targetDocument = this.cache.get(documentUrl);
    if (!targetDocument) {
      if (!this.options.resolveExternalRef) {
        this.warnings.push(
          warning(
            "openapi.external_ref_blocked",
            `External reference ${documentUrl} requires an explicit resolver.`,
          ),
        );
        return undefined;
      }
      try {
        const loaded = await this.options.resolveExternalRef(documentUrl);
        const parsed: unknown =
          typeof loaded === "string" ? (parseYaml(loaded) as unknown) : loaded;
        if (!isRecord(parsed))
          throw new Error("Referenced document is not an object.");
        targetDocument = parsed;
        this.cache.set(documentUrl, parsed);
        this.contexts.set(parsed, documentUrl);
      } catch (error) {
        this.warnings.push(
          warning(
            "openapi.external_ref_failed",
            `Could not resolve ${documentUrl}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return undefined;
      }
    }
    const target = resolvePointer(targetDocument, fragment);
    const resolved = await this.record(target, documentUrl, [
      ...chain,
      absolute,
    ]);
    if (resolved) this.contexts.set(resolved, documentUrl);
    return resolved;
  }
}

function resolvePointer(root: unknown, fragment: string): unknown {
  if (!fragment || fragment === "#") return root;
  const pointer = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  if (!pointer.startsWith("/")) return undefined;
  return pointer
    .split("/")
    .slice(1)
    .map((part) =>
      decodeURIComponent(part.replaceAll("~1", "/").replaceAll("~0", "~")),
    )
    .reduce<unknown>(
      (value, key) => (isRecord(value) ? value[key] : undefined),
      root,
    );
}

function splitReference(value: string): [string, string] {
  const index = value.indexOf("#");
  return index < 0 ? [value, ""] : [value.slice(0, index), value.slice(index)];
}

function stripFragment(value: string): string {
  return splitReference(value)[0];
}

async function parameterExample(
  parameter: Record<string, unknown>,
  resolver: ReferenceResolver,
  currentBase: string,
  warnings: ImportWarning[],
  path: string,
): Promise<unknown> {
  if ("example" in parameter) return parameter.example;
  if ("default" in parameter) return parameter.default;
  return schemaExample(
    parameter.schema,
    resolver,
    currentBase,
    warnings,
    `${path}.schema`,
  );
}

async function schemaExample(
  value: unknown,
  resolver: ReferenceResolver,
  currentBase: string,
  warnings: ImportWarning[],
  path: string,
  ancestors = new Set<object>(),
  depth = 0,
): Promise<unknown> {
  if (!isRecord(value)) return undefined;
  if (depth >= resolver.maxDepth) {
    warnings.push(
      warning(
        "openapi.schema_depth",
        `Schema example depth exceeded ${resolver.maxDepth}.`,
        path,
      ),
    );
    return undefined;
  }
  const schema = await resolver.record(value, currentBase, [path]);
  if (!schema) return undefined;
  if (ancestors.has(schema)) {
    warnings.push(
      warning(
        "openapi.schema_cycle",
        "A recursive schema was truncated while generating an example.",
        path,
      ),
    );
    return undefined;
  }
  ancestors.add(schema);
  const schemaBase = resolver.baseOf(schema, currentBase);
  try {
    if ("example" in schema) return schema.example;
    if ("default" in schema) return schema.default;
    if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
    if (Array.isArray(schema.allOf)) {
      const merged: Record<string, unknown> = {};
      let fallback: unknown;
      for (const [index, item] of schema.allOf.entries()) {
        const value = await schemaExample(
          item,
          resolver,
          schemaBase,
          warnings,
          `${path}.allOf.${index}`,
          ancestors,
          depth + 1,
        );
        if (isRecord(value)) Object.assign(merged, value);
        else if (fallback === undefined) fallback = value;
      }
      return Object.keys(merged).length ? merged : fallback;
    }
    const alternatives = Array.isArray(schema.oneOf)
      ? schema.oneOf
      : Array.isArray(schema.anyOf)
        ? schema.anyOf
        : [];
    if (alternatives.length) {
      return schemaExample(
        alternatives[0],
        resolver,
        schemaBase,
        warnings,
        `${path}.${Array.isArray(schema.oneOf) ? "oneOf" : "anyOf"}.0`,
        ancestors,
        depth + 1,
      );
    }
    const type = asString(schema.type);
    if (type === "object" || isRecord(schema.properties)) {
      const properties = isRecord(schema.properties) ? schema.properties : {};
      const example: Record<string, unknown> = {};
      for (const [name, property] of Object.entries(properties)) {
        example[name] =
          (await schemaExample(
            property,
            resolver,
            schemaBase,
            warnings,
            `${path}.properties.${name}`,
            ancestors,
            depth + 1,
          )) ?? "";
      }
      return example;
    }
    if (type === "array") {
      const item = await schemaExample(
        schema.items,
        resolver,
        schemaBase,
        warnings,
        `${path}.items`,
        ancestors,
        depth + 1,
      );
      return item === undefined ? [] : [item];
    }
    if (type === "boolean") return false;
    if (type === "integer" || type === "number") return 0;
    if (type === "string") return "";
    return undefined;
  } finally {
    ancestors.delete(schema);
  }
}

function expandServerUrl(value: string): string {
  return value.replace(/\{([^}]+)\}/g, (_match, name: string) => `{${name}}`);
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

function stringifyExample(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return value.toString();
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return value.description ?? "";
  return "";
}

function hasHeader(headers: KeyValueItem[], name: string): boolean {
  return headers.some(
    (header) => header.name.toLowerCase() === name.toLowerCase(),
  );
}

function arrayValues(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return arrayValues(value).filter(isRecord);
}

function firstString(value: unknown): string | undefined {
  return arrayValues(value).find(
    (item): item is string => typeof item === "string",
  );
}

function originFileName(origin: string, suffix: string): string {
  return `${origin.replace(/^https?:\/\//, "").replace(/[^A-Za-z0-9.-]+/g, "_") || "localhost"}.${suffix}.json`;
}

function parameterFromEntry(
  entry: KeyValueItem,
  location: "query" | "header",
): Record<string, unknown> {
  return {
    name: entry.name,
    in: location,
    required: false,
    schema: { type: inferScalarType(entry.value), default: entry.value },
    example: entry.value,
  };
}

function pathParameters(path: string): Record<string, unknown>[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
    name: match[1],
    in: "path",
    required: true,
    schema: { type: "string" },
  }));
}

function safeOperationId(request: RequestSpecV1): string {
  const value = request.name
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return value || `${request.method.toLowerCase()}Request`;
}

function safeUrl(value: string, fallback: string): URL {
  try {
    return new URL(value);
  } catch {
    return new URL(fallback);
  }
}

function inferScalarType(
  value: string,
): "boolean" | "integer" | "number" | "string" {
  if (value === "true" || value === "false") return "boolean";
  if (/^-?\d+$/.test(value)) return "integer";
  if (/^-?(?:\d+\.\d*|\d*\.\d+)$/.test(value)) return "number";
  return "string";
}

function inferSchema(value: unknown): Record<string, unknown> {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    return { type: "array", items: value.length ? inferSchema(value[0]) : {} };
  }
  if (isRecord(value)) {
    return {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(value).map(([name, item]) => [name, inferSchema(item)]),
      ),
    };
  }
  if (typeof value === "boolean") return { type: "boolean" };
  if (typeof value === "number") {
    return { type: Number.isInteger(value) ? "integer" : "number" };
  }
  return { type: "string" };
}

function schemaFromBody(request: RequestSpecV1): Record<string, unknown> {
  if (request.body.kind === "json") {
    try {
      return inferSchema(JSON.parse(request.body.text));
    } catch {
      return { type: "string" };
    }
  }
  if (request.body.kind === "file") {
    return { type: "string", format: "binary" };
  }
  return { type: "string" };
}
