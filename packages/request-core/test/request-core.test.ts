import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  collectionFileV1Schema,
  createDefaultRequest,
  REDACTED_VALUE,
} from "@xpanel/contracts";
import { describe, expect, it } from "vitest";

import {
  compactJson,
  detectImportFormat,
  exportCollectionFile,
  exportCollectionFileWithWarnings,
  exportCurlBash,
  exportHar,
  exportHarWithWarnings,
  exportNodeFetch,
  exportOpenApi,
  exportPowerShell,
  exportSwagger,
  importHar,
  importOpenApi,
  mergeCollectionFiles,
  parseCollectionFile,
  parseCurlBash,
  parseImport,
  parseNodeFetch,
  parsePowerShell,
  prettyJson,
} from "../src/index.js";

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
    "utf8",
  );
}

describe("static command formats", () => {
  it("defaults imported requests to 60 seconds and keeps explicit overrides", () => {
    expect(
      parseCurlBash("curl 'https://api.example.com'").requests[0]?.options
        .timeoutMs,
    ).toBe(60_000);
    expect(
      parsePowerShell("Invoke-WebRequest -Uri 'https://api.example.com'")
        .requests[0]?.options.timeoutMs,
    ).toBe(60_000);
    expect(
      parseNodeFetch("fetch('https://api.example.com')").requests[0]?.options
        .timeoutMs,
    ).toBe(60_000);
    expect(
      parseCurlBash("curl 'https://api.example.com' --max-time '2.5'")
        .requests[0]?.options.timeoutMs,
    ).toBe(2_500);
    expect(
      parsePowerShell(
        "Invoke-WebRequest -Uri 'https://api.example.com' -TimeoutSec 7",
      ).requests[0]?.options.timeoutMs,
    ).toBe(7_000);
  });

  it("round-trips static AbortSignal timeouts and rejects dynamic values", () => {
    const imported = parseNodeFetch(`
const timeoutMs = 12_345
fetch("https://api.example.com", {
  signal: AbortSignal.timeout(timeoutMs),
})`);
    expect(imported.requests[0]?.options.timeoutMs).toBe(12_345);

    const exported = exportNodeFetch(imported.requests[0]!, {
      includeSensitive: true,
    });
    expect(exported.text).toContain("signal: AbortSignal.timeout(12345)");
    expect(parseNodeFetch(exported.text).requests[0]?.options.timeoutMs).toBe(
      12_345,
    );

    const dynamic = parseNodeFetch(
      'fetch("https://api.example.com", { signal: AbortSignal.timeout(getTimeout()) })',
    );
    expect(dynamic.requests[0]?.options.timeoutMs).toBe(60_000);
    expect(dynamic.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "fetch.timeout_dynamic" }),
      ]),
    );

    const nonNumeric = parseNodeFetch(
      'fetch("https://api.example.com", { signal: AbortSignal.timeout("5000") })',
    );
    expect(nonNumeric.requests[0]?.options.timeoutMs).toBe(60_000);
    expect(nonNumeric.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "fetch.timeout_invalid" }),
      ]),
    );

    for (const value of ["0", "12.5"]) {
      const invalid = parseNodeFetch(
        `fetch("https://api.example.com", { signal: AbortSignal.timeout(${value}) })`,
      );
      expect(invalid.requests[0]?.options.timeoutMs).toBe(60_000);
      expect(invalid.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "fetch.timeout_invalid" }),
        ]),
      );
    }

    const tooLong = parseNodeFetch(
      'fetch("https://api.example.com", { signal: AbortSignal.timeout(86_400_001) })',
    );
    expect(tooLong.requests[0]?.options.timeoutMs).toBe(86_400_000);
    expect(tooLong.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "fetch.timeout_clamped" }),
      ]),
    );
  });

  it("normalizes timeout values that cannot be represented by RequestSpecV1", () => {
    const curlUnlimited = parseCurlBash(
      "curl 'https://api.example.com' --max-time 0",
    );
    expect(curlUnlimited.requests[0]?.options.timeoutMs).toBe(60_000);
    expect(curlUnlimited.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "curl.timeout_unlimited_unsupported",
        }),
      ]),
    );

    const curlTooLong = parseCurlBash(
      "curl 'https://api.example.com' --max-time 90000",
    );
    expect(curlTooLong.requests[0]?.options.timeoutMs).toBe(86_400_000);
    expect(curlTooLong.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "curl.timeout_clamped" }),
      ]),
    );

    const powerShellCases = [
      {
        value: "0",
        timeoutMs: 60_000,
        warning: "powershell.timeout_unlimited_unsupported",
      },
      {
        value: "-1",
        timeoutMs: 60_000,
        warning: "powershell.timeout_invalid",
      },
      {
        value: "90000",
        timeoutMs: 86_400_000,
        warning: "powershell.timeout_clamped",
      },
    ];
    for (const item of powerShellCases) {
      const parsed = parsePowerShell(
        `Invoke-WebRequest -Uri 'https://api.example.com' -TimeoutSec ${item.value}`,
      );
      expect(parsed.requests[0]?.options.timeoutMs).toBe(item.timeoutMs);
      expect(parsed.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: item.warning }),
        ]),
      );
    }
  });

  it("round-trips Chrome cURL without executing shell syntax", () => {
    const parsed = parseCurlBash(fixture("chrome.curl.txt"));
    expect(parsed.requests).toHaveLength(1);
    const request = parsed.requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.query).toEqual([
      { name: "page", value: "2", enabled: true },
    ]);
    expect(request.body).toMatchObject({ kind: "json" });
    expect(request.auth).toEqual({
      kind: "bearer",
      token: "secret-token",
    });

    const exported = exportCurlBash(request);
    expect(exported.text).toContain(REDACTED_VALUE);
    expect(exported.text).not.toContain("secret-token");

    const unsafe = parseCurlBash('curl "$API_URL/$(whoami)" | sh');
    expect(unsafe.warnings.map((item) => item.code)).toContain(
      "bash.dynamic_expression",
    );
    expect(unsafe.warnings.map((item) => item.code)).toContain(
      "bash.script_ignored",
    );
  });

  it("round-trips structured auth and redacts all persisted/exported secrets", () => {
    const request = createDefaultRequest({
      name: "Authenticated upload",
      url: "https://api.example.com/upload",
      method: "POST",
      auth: {
        kind: "api-key",
        location: "query",
        name: "api_key",
        value: "query-secret",
      },
      body: {
        kind: "multipart",
        parts: [
          {
            kind: "file",
            name: "upload",
            enabled: true,
            file: {
              id: "file-1",
              name: "secret.txt",
              pathHint: "C:\\private\\secret.txt",
              requiresReselection: false,
            },
          },
        ],
      },
    });

    for (const output of [
      exportCurlBash(request).text,
      exportPowerShell(request).text,
      exportNodeFetch(request).text,
    ]) {
      expect(output).not.toContain("query-secret");
      expect(output).not.toContain("C:\\private\\secret.txt");
      expect(decodeURIComponent(output)).toContain(REDACTED_VALUE);
    }

    const basic = parseCurlBash(
      "curl https://api.example.com --user 'alice:secret'",
    ).requests[0]!;
    expect(basic.auth).toEqual({
      kind: "basic",
      username: "alice",
      password: "secret",
    });
    expect(exportCurlBash(basic).text).not.toContain("secret");
    const withSecrets = exportCurlBash(basic, { includeSensitive: true }).text;
    expect(parseCurlBash(withSecrets).requests[0]?.auth).toEqual(basic.auth);
  });

  it("strongly sanitizes JSON keys and ambiguous text in cURL exports", () => {
    const jsonRequest = createDefaultRequest({
      url: "https://api.example.com/profile",
      method: "POST",
      body: {
        kind: "json",
        text: JSON.stringify({
          username: "alice",
          password: "body-secret",
          nested: { session_id: "session-secret" },
        }),
      },
    });
    const jsonExport = exportCurlBash(jsonRequest);
    expect(jsonExport.text).toContain("alice");
    expect(jsonExport.text).not.toContain("body-secret");
    expect(jsonExport.text).not.toContain("session-secret");
    expect(jsonExport.text).toContain(REDACTED_VALUE);
    expect(
      exportCurlBash(jsonRequest, { includeSensitive: true }).text,
    ).toContain("body-secret");

    const textExport = exportCurlBash(
      createDefaultRequest({
        url: "https://api.example.com/raw",
        method: "POST",
        body: { kind: "text", text: "unstructured-secret" },
      }),
    );
    expect(textExport.text).not.toContain("unstructured-secret");
    expect(textExport.text).toContain(REDACTED_VALUE);
    expect(textExport.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "export.body_text_redacted" }),
      ]),
    );
  });

  it("preserves raw file bodies and browser-unsupported cURL options without reading files", () => {
    const parsed = parseCurlBash(
      "curl 'https://api.example.com/upload' --data-binary '@C:\\private\\payload.bin' --proxy 'http://localhost:8080' --proxy-user 'alice:proxy-secret' --noproxy 'localhost,127.0.0.1' --cacert 'C:\\private\\ca.pem' --cert 'C:\\private\\client.pem:cert-secret' --key 'C:\\private\\client.key'",
    );
    const request = parsed.requests[0]!;
    expect(request.body).toMatchObject({
      kind: "file",
      file: {
        name: "payload.bin",
        requiresReselection: true,
      },
    });
    expect(request.options).toMatchObject({
      proxy: {
        url: "http://localhost:8080",
        username: "alice",
        password: "proxy-secret",
        bypass: ["localhost", "127.0.0.1"],
      },
      tls: {
        verify: true,
        caFile: { name: "ca.pem", requiresReselection: true },
        clientCertificate: {
          certificate: { name: "client.pem" },
          privateKey: { name: "client.key" },
          passphrase: "cert-secret",
        },
      },
    });
    expect(
      parsed.warnings.some(
        (item) =>
          item.code === "curl.browser_unsupported_option" &&
          item.message.includes("explicit proxy"),
      ),
    ).toBe(true);
    const exported = exportCurlBash(request);
    expect(exported.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "export.file_path_hint" }),
      ]),
    );
    expect(exported.text).not.toContain("C:\\private");
    expect(exported.text).not.toContain("proxy-secret");
    expect(exported.text).not.toContain("cert-secret");

    expect(
      parsePowerShell(
        "Invoke-WebRequest -Uri 'https://api.example.com/upload' -Method 'POST' -InFile 'C:\\private\\payload.bin'",
      ).requests[0]?.body,
    ).toMatchObject({ kind: "file", file: { name: "payload.bin" } });
    expect(
      parseNodeFetch(
        'fetch("https://api.example.com/upload", { method: "POST", body: new File([], "payload.bin") })',
      ).requests[0]?.body,
    ).toMatchObject({ kind: "file", file: { name: "payload.bin" } });
  });

  it("round-trips a static PowerShell request and warns for subexpressions", () => {
    const parsed = parsePowerShell(fixture("chrome.powershell.txt"));
    expect(parsed.requests).toHaveLength(1);
    const request = parsed.requests[0]!;
    expect(request.headers).toContainEqual({
      name: "Accept",
      value: "application/json",
      enabled: true,
    });
    expect(exportPowerShell(request).text).toContain("Invoke-WebRequest");
    expect(
      parsePowerShell(
        "Invoke-WebRequest -Uri 'https://api.example.com' -Proxy 'http://127.0.0.1:8080'",
      ).warnings,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "powershell.browser_unsupported_option",
        }),
      ]),
    );
    expect(
      parsePowerShell('Invoke-WebRequest -Uri "$(Get-Item x)"').warnings,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "powershell.dynamic_expression" }),
      ]),
    );
  });

  it("uses an AST to parse Node fetch and keeps dynamic bodies out", () => {
    const parsed = parseNodeFetch(fixture("chrome.fetch.mjs"));
    expect(parsed.requests).toHaveLength(1);
    const request = parsed.requests[0]!;
    expect(request.body).toMatchObject({
      kind: "json",
      text: '{"name":"xPanel"}',
    });
    expect(exportNodeFetch(request).text).toContain("await fetch");

    const dynamic = parseNodeFetch(
      "fetch(urlFromUser, { body: readFileSync(path) })",
    );
    expect(dynamic.requests).toHaveLength(0);
    expect(dynamic.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "fetch.url_dynamic" }),
      ]),
    );
  });
});

describe("document formats", () => {
  it("imports and exports HAR 1.2 with default redaction", () => {
    const imported = importHar(fixture("network.har.json"));
    expect(imported.requests).toHaveLength(1);
    expect(imported.responses[0]).toMatchObject({ status: 201 });
    const result = exportHarWithWarnings(imported.requests, imported.responses);
    const exported = JSON.stringify(result.value);
    expect(exported).toContain(REDACTED_VALUE);
    expect(exported).not.toContain("secret-token");
    expect(exported).not.toContain("sid=secret");
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "export.response_body_redacted" }),
      ]),
    );
    const included = JSON.stringify(
      exportHar(imported.requests, imported.responses, {
        includeSensitive: true,
      }),
    );
    expect(included).toContain('{\\"id\\":\\"1\\"}');
  });

  it("imports OpenAPI 3 YAML, resolves local refs, and exports per origin", async () => {
    const imported = await importOpenApi(fixture("openapi.yaml"));
    expect(imported.format).toBe("openapi");
    expect(imported.requests).toHaveLength(1);
    expect(imported.requests[0]).toMatchObject({
      method: "POST",
      url: "https://api.example.com/items/item-1",
      body: { kind: "json" },
    });
    const second = createDefaultRequest({
      url: "https://other.example.com/ping",
      name: "Ping",
    });
    const generated = exportOpenApi([imported.requests[0]!, second]);
    expect(Object.keys(generated.documents)).toHaveLength(2);
    expect(Object.values(generated.documents)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ "x-xpanel-generated": true }),
      ]),
    );

    const authenticated = createDefaultRequest({
      name: "Authenticated",
      url: "https://api.example.com/private",
      auth: { kind: "bearer", token: "openapi-secret" },
    });
    const authDocument = Object.values(
      exportOpenApi([authenticated]).documents,
    )[0]!;
    expect(JSON.stringify(authDocument)).not.toContain("openapi-secret");
    expect(authDocument).toMatchObject({
      components: {
        securitySchemes: {
          xpanelBearer: { type: "http", scheme: "bearer" },
        },
      },
    });
    const authRoundTrip = await importOpenApi(authDocument);
    expect(authRoundTrip.requests[0]?.auth).toEqual({
      kind: "bearer",
      token: REDACTED_VALUE,
    });
  });

  it("round-trips raw file bodies through HAR and OpenAPI placeholders", async () => {
    const request = createDefaultRequest({
      name: "Raw upload",
      method: "POST",
      url: "https://api.example.com/raw",
      body: {
        kind: "file",
        file: {
          id: "body-1",
          name: "payload.bin",
          pathHint: "C:\\private\\payload.bin",
          requiresReselection: false,
        },
        mediaType: "application/octet-stream",
      },
    });
    const harResult = exportHarWithWarnings([request]);
    const har = harResult.value;
    expect(JSON.stringify(har)).not.toContain("C:\\private");
    expect(importHar(har).requests[0]?.body).toMatchObject({
      kind: "file",
      file: { name: REDACTED_VALUE, requiresReselection: true },
    });
    expect(harResult.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "export.file_metadata_redacted" }),
      ]),
    );

    const document = Object.values(exportOpenApi([request]).documents)[0]!;
    expect(JSON.stringify(document)).not.toContain("C:\\private");
    expect((await importOpenApi(document)).requests[0]?.body).toMatchObject({
      kind: "file",
      mediaType: "application/octet-stream",
      file: { requiresReselection: true },
    });
  });

  it("allows external refs only through a caller resolver and detects cycles", async () => {
    const source = `openapi: 3.1.0
info: { title: External, version: 1.0.0 }
servers: [{ url: https://api.example.com }]
paths:
  /items:
    $ref: https://schemas.example.test/path.yaml#/ItemPath
`;
    const blocked = await importOpenApi(source);
    expect(blocked.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "openapi.external_ref_blocked" }),
      ]),
    );
    const resolved = await importOpenApi(source, {
      resolveExternalRef: () =>
        Promise.resolve({
          ItemPath: { get: { responses: { 200: { description: "OK" } } } },
        }),
    });
    expect(resolved.requests).toHaveLength(1);

    const cycle = await importOpenApi(`openapi: 3.1.0
info: { title: Cycle, version: 1.0.0 }
paths:
  /cycle:
    $ref: '#/paths/~1cycle'
`);
    expect(cycle.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "openapi.ref_cycle" }),
      ]),
    );
  });

  it("keeps the resolved document base across nested external refs", async () => {
    const requestedUrls: string[] = [];
    const documents: Record<string, object> = {
      "https://schemas.example.test/paths.yaml": {
        ItemPath: {
          post: {
            parameters: [{ $ref: "./params.yaml#/Trace" }],
            requestBody: { $ref: "./body.yaml#/Body" },
            responses: { 200: { description: "OK" } },
          },
        },
      },
      "https://schemas.example.test/params.yaml": {
        Trace: {
          name: "X-Trace",
          in: "header",
          schema: { $ref: "./schemas.yaml#/TraceId" },
        },
      },
      "https://schemas.example.test/body.yaml": {
        Body: {
          content: {
            "application/json": {
              schema: { $ref: "./schemas.yaml#/Payload" },
            },
          },
        },
      },
      "https://schemas.example.test/schemas.yaml": {
        TraceId: { type: "string", example: "trace-1" },
        Payload: {
          type: "object",
          properties: {
            name: { type: "string", example: "nested" },
            meta: { $ref: "#/Meta" },
          },
        },
        Meta: {
          type: "object",
          properties: { count: { type: "integer", example: 3 } },
        },
      },
    };
    const source = `openapi: 3.1.0
info: { title: Nested, version: 1.0.0 }
servers: [{ url: https://api.example.com }]
paths:
  /items:
    $ref: ./paths.yaml#/ItemPath
`;
    const imported = await importOpenApi(source, {
      baseUrl: "https://schemas.example.test/root.yaml",
      resolveExternalRef: (url) => {
        requestedUrls.push(url);
        const document = documents[url];
        return document
          ? Promise.resolve(document)
          : Promise.reject(new Error(`Unexpected URL: ${url}`));
      },
    });

    expect(new Set(requestedUrls)).toEqual(new Set(Object.keys(documents)));
    expect(imported.requests[0]?.headers).toContainEqual({
      name: "X-Trace",
      value: "trace-1",
      enabled: true,
    });
    expect(imported.requests[0]?.body).toMatchObject({
      kind: "json",
      text: JSON.stringify({ name: "nested", meta: { count: 3 } }, null, 2),
    });
    expect(imported.warnings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "openapi.external_ref_failed" }),
      ]),
    );
  });

  it("truncates recursive component schemas with an explicit warning", async () => {
    const imported = await importOpenApi(`openapi: 3.1.0
info: { title: Recursive, version: 1.0.0 }
servers: [{ url: https://api.example.com }]
paths:
  /nodes:
    post:
      requestBody:
        content:
          application/json:
            schema: { $ref: '#/components/schemas/Node' }
      responses: { '200': { description: OK } }
components:
  schemas:
    Node:
      type: object
      properties:
        name: { type: string, example: root }
        child: { $ref: '#/components/schemas/Node' }
`);

    expect(imported.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "openapi.schema_cycle" }),
      ]),
    );
    expect(imported.requests[0]?.body).toMatchObject({
      kind: "json",
      text: JSON.stringify({ name: "root", child: "" }, null, 2),
    });
  });

  it("imports and exports Swagger 2.0", async () => {
    const imported = await importOpenApi(fixture("swagger.json"));
    expect(imported.format).toBe("swagger");
    expect(imported.requests[0]).toMatchObject({
      url: "https://legacy.example.com/api/login",
      body: { kind: "urlencoded" },
    });
    const generated = exportSwagger(imported.requests);
    expect(Object.values(generated.documents)[0]).toMatchObject({
      swagger: "2.0",
      "x-xpanel-generated": true,
    });

    const request = imported.requests[0]!;
    const generatedWithResponse = exportSwagger([request], {
      includeSensitive: true,
      responses: [
        {
          requestId: request.id,
          executor: "browser",
          status: 201,
          statusText: "Created",
          headers: [
            { name: "Content-Type", value: "application/json", enabled: true },
          ],
          body: {
            kind: "inline",
            encoding: "utf8",
            content: '{"id":1}',
            mediaType: "application/json",
            sizeBytes: 8,
          },
          timings: {
            startedAt: "2026-09-02T00:00:00.000Z",
            durationMs: 1,
          },
          redirects: [],
          warnings: [],
        },
      ],
    });
    const swaggerDocument = Object.values(generatedWithResponse.documents)[0]!;
    expect(swaggerDocument).toMatchObject({
      paths: {
        "/api/login": {
          post: {
            responses: {
              201: {
                description: "Created",
                schema: {
                  type: "object",
                  properties: { id: { type: "integer" } },
                },
                examples: { "application/json": { id: 1 } },
              },
            },
          },
        },
      },
    });
  });
});

describe("collection, JSON, and detection helpers", () => {
  it("rejects unknown collection versions without migration", () => {
    const parsed = parseCollectionFile({ schemaVersion: 99 });
    expect(parsed.file).toBeUndefined();
    expect(parsed.warnings[0]?.code).toBe("collection.version_unsupported");
  });

  it("exports sanitized collections and imports conflicts as new ids/names", () => {
    const now = new Date().toISOString();
    const request = createDefaultRequest({
      id: "request-1",
      name: "Secret request",
      url: "https://api.example.com",
      headers: [
        { name: "Authorization", value: "Bearer secret", enabled: true },
      ],
      body: { kind: "text", text: "collection-body-secret" },
    });
    const collection = {
      id: "collection-1",
      name: "Favorites",
      description: "",
      requestIds: [request.id],
      createdAt: now,
      updatedAt: now,
    };
    const result = exportCollectionFileWithWarnings([collection], [request], {
      exportedAt: now,
    });
    const file = result.value;
    expect(file.requests[0]?.headers[0]?.value).toBe(REDACTED_VALUE);
    expect(file.requests[0]?.body).toEqual({
      kind: "text",
      text: REDACTED_VALUE,
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "export.body_text_redacted" }),
      ]),
    );
    expect(
      exportCollectionFile([collection], [request], {
        exportedAt: now,
        includeSensitive: true,
      }).requests[0]?.body,
    ).toEqual(request.body);
    expect(collectionFileV1Schema.parse(file)).toEqual(file);

    const merged = mergeCollectionFiles(file, file);
    expect(new Set(merged.requests.map((item) => item.id)).size).toBe(2);
    expect(merged.collections.map((item) => item.name)).toEqual([
      "Favorites",
      "Favorites (imported)",
    ]);
  });

  it("pretty-prints, compacts, detects, and dispatches supported input", async () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(compactJson('{\n "a": 1\n}')).toBe('{"a":1}');
    expect(detectImportFormat(fixture("network.har.json"))).toBe("har");
    expect(detectImportFormat(fixture("openapi.yaml"))).toBe("openapi");
    expect((await parseImport(fixture("chrome.curl.txt"))).format).toBe(
      "curl-bash",
    );
  });
});
