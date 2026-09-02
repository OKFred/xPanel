import { describe, expect, it } from "vitest";

import {
  CollectionFileV1Schema,
  REDACTED_VALUE,
  RequestSpecV1Schema,
  createDefaultRequest,
  isSensitiveHeader,
  redactCollectionFile,
  redactCollectionFileForExport,
  redactRequest,
  redactRequestForExport,
  redactResponseForExport,
  type BodySpec,
} from "../src/index.js";

const fixedId = () => "request-1";

describe("RequestSpecV1", () => {
  it("creates a schema-valid safe default", () => {
    const request = createDefaultRequest({}, fixedId);

    expect(RequestSpecV1Schema.parse(request)).toEqual(request);
    expect(request).toMatchObject({
      id: "request-1",
      method: "GET",
      auth: { kind: "none" },
      body: { kind: "none" },
      options: { proxy: null, tls: { verify: true } },
    });
  });

  it("rejects unknown keys and unknown schema versions", () => {
    const request = createDefaultRequest({}, fixedId);
    expect(
      RequestSpecV1Schema.safeParse({ ...request, script: "do-not-run()" })
        .success,
    ).toBe(false);
    expect(
      CollectionFileV1Schema.safeParse({
        schemaVersion: 2,
        exportedAt: new Date().toISOString(),
        collections: [],
        requests: [],
      }).success,
    ).toBe(false);
  });

  it("validates all request body variants", () => {
    const variants = [
      { kind: "text", text: "hello", mediaType: "text/plain" },
      { kind: "json", text: '{"ok":true}' },
      {
        kind: "urlencoded",
        entries: [{ name: "q", value: "x", enabled: true }],
      },
      {
        kind: "multipart",
        parts: [
          { kind: "text", name: "title", value: "xPanel", enabled: true },
          {
            kind: "file",
            name: "upload",
            enabled: true,
            file: {
              id: "file-1",
              name: "sample.txt",
              size: 4,
              requiresReselection: true,
            },
          },
        ],
      },
      {
        kind: "file",
        file: {
          id: "file-body-1",
          name: "body.bin",
          requiresReselection: true,
        },
        mediaType: "application/octet-stream",
      },
    ] satisfies BodySpec[];

    for (const body of variants) {
      expect(
        RequestSpecV1Schema.safeParse(createDefaultRequest({ body }, fixedId))
          .success,
      ).toBe(true);
    }
  });
});

describe("redaction", () => {
  it.each(["Authorization", "cookie", "X-API-Key", "x_auth_token"])(
    "recognizes sensitive header %s",
    (name) => {
      expect(isSensitiveHeader(name)).toBe(true);
    },
  );

  it.each(["password", "passwd", "session", "session_id"])(
    "recognizes sensitive name %s",
    (name) => {
      expect(isSensitiveHeader(name)).toBe(true);
    },
  );

  it("redacts credentials, sensitive headers, and local file paths without mutating input", () => {
    const request = createDefaultRequest(
      {
        headers: [
          { name: "Authorization", value: "Bearer secret", enabled: true },
        ],
        auth: { kind: "basic", username: "alice", password: "secret" },
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
        options: {
          redirect: "follow",
          cookieMode: "include",
          timeoutMs: 1_000,
          proxy: {
            url: "http://localhost:8080",
            password: "secret",
            bypass: [],
          },
          tls: { verify: true },
        },
      },
      fixedId,
    );

    const redacted = redactRequest(request);

    expect(redacted.headers[0]?.value).toBe(REDACTED_VALUE);
    expect(redacted.auth).toMatchObject({ password: REDACTED_VALUE });
    expect(redacted.options.proxy).toMatchObject({ password: REDACTED_VALUE });
    expect(redacted.body).toMatchObject({
      parts: [
        { file: { pathHint: REDACTED_VALUE, requiresReselection: true } },
      ],
    });
    expect(request.headers[0]?.value).toBe("Bearer secret");
  });

  it("redacts every request in a collection backup", () => {
    const request = createDefaultRequest(
      {
        auth: { kind: "bearer", token: "secret" },
      },
      fixedId,
    );
    const now = new Date().toISOString();
    const output = redactCollectionFile({
      schemaVersion: 1,
      exportedAt: now,
      collections: [
        {
          id: "collection-1",
          name: "Favorites",
          description: "",
          requestIds: [request.id],
          createdAt: now,
          updatedAt: now,
        },
      ],
      requests: [request],
    });

    expect(output.requests[0]?.auth).toEqual({
      kind: "bearer",
      token: REDACTED_VALUE,
    });
  });

  it("always requires file reselection after sanitizing persisted data", () => {
    const request = createDefaultRequest(
      {
        body: {
          kind: "multipart",
          parts: [
            {
              kind: "file",
              name: "upload",
              enabled: true,
              file: {
                id: "file-1",
                name: "memory-only.txt",
                requiresReselection: false,
              },
            },
          ],
        },
      },
      fixedId,
    );

    expect(redactRequest(request).body).toMatchObject({
      parts: [{ file: { requiresReselection: true } }],
    });
  });

  it("sanitizes a raw file body", () => {
    const request = createDefaultRequest(
      {
        body: {
          kind: "file",
          file: {
            id: "file-body-1",
            name: "body.bin",
            requiresReselection: false,
          },
        },
      },
      fixedId,
    );

    expect(redactRequest(request).body).toMatchObject({
      kind: "file",
      file: { requiresReselection: true },
    });
  });

  it("redacts URL userinfo and sensitive query values without crashing on templates", () => {
    const request = createDefaultRequest(
      {
        url: "https://alice:secret@example.com/private?token=url-secret",
        query: [{ name: "session_id", value: "session-secret", enabled: true }],
        options: {
          redirect: "follow",
          cookieMode: "include",
          timeoutMs: 1_000,
          proxy: {
            url: "http://proxy-user:proxy-secret@localhost:8080",
            bypass: [],
          },
          tls: { verify: true },
        },
      },
      fixedId,
    );

    const redacted = redactRequest(request);
    expect(redacted.url).not.toContain("alice");
    expect(redacted.url).not.toContain("secret");
    expect(decodeURIComponent(redacted.url)).toContain(REDACTED_VALUE);
    expect(redacted.options.proxy?.url).not.toContain("proxy-user");
    expect(redacted.options.proxy?.url).not.toContain("proxy-secret");
    expect(redacted.query[0]?.value).toBe(REDACTED_VALUE);

    const template = createDefaultRequest(
      { url: "https://user:pass@{host}/items/{id}" },
      fixedId,
    );
    expect(() => redactRequest(template)).not.toThrow();
    expect(redactRequest(template).url).not.toContain("user:pass");
  });

  it("keeps ordinary local bodies while redacting deterministic sensitive fields", () => {
    const jsonRequest = createDefaultRequest(
      {
        body: {
          kind: "json",
          text: JSON.stringify({
            username: "alice",
            password: "secret",
            nested: { session_id: "session-secret", count: 1 },
          }),
        },
      },
      fixedId,
    );
    const jsonBody = redactRequest(jsonRequest).body;
    expect(jsonBody.kind).toBe("json");
    if (jsonBody.kind === "json") {
      expect(JSON.parse(jsonBody.text)).toEqual({
        username: "alice",
        password: REDACTED_VALUE,
        nested: { session_id: REDACTED_VALUE, count: 1 },
      });
    }

    const textRequest = createDefaultRequest(
      { body: { kind: "text", text: "ordinary local draft" } },
      fixedId,
    );
    expect(redactRequest(textRequest).body).toEqual(textRequest.body);

    const structuredRequest = createDefaultRequest(
      {
        body: {
          kind: "multipart",
          parts: [
            {
              kind: "text",
              name: "title",
              value: "kept",
              enabled: true,
            },
            {
              kind: "text",
              name: "password",
              value: "secret",
              enabled: true,
            },
          ],
        },
      },
      fixedId,
    );
    expect(redactRequest(structuredRequest).body).toMatchObject({
      parts: [
        { name: "title", value: "kept" },
        { name: "password", value: REDACTED_VALUE },
      ],
    });
  });

  it("strongly sanitizes ambiguous export bodies and reports warnings", () => {
    const textRequest = createDefaultRequest(
      { body: { kind: "text", text: "possibly secret" } },
      fixedId,
    );
    const textExport = redactRequestForExport(textRequest);
    expect(textExport.value.body).toEqual({
      kind: "text",
      text: REDACTED_VALUE,
    });
    expect(textExport.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "export.body_text_redacted" }),
      ]),
    );

    const fileRequest = createDefaultRequest(
      {
        body: {
          kind: "file",
          file: {
            id: "local-file-id",
            name: "salary.csv",
            size: 42,
            sha256: "a".repeat(64),
            pathHint: "C:\\private\\salary.csv",
            requiresReselection: false,
          },
        },
      },
      fixedId,
    );
    expect(redactRequestForExport(fileRequest)).toMatchObject({
      value: {
        body: {
          kind: "file",
          file: {
            id: REDACTED_VALUE,
            name: REDACTED_VALUE,
            requiresReselection: true,
          },
        },
      },
      warnings: [{ code: "export.file_metadata_redacted" }],
    });

    const responseExport = redactResponseForExport({
      requestId: "request-1",
      executor: "browser",
      status: 200,
      statusText: "OK",
      headers: [],
      body: {
        kind: "inline",
        encoding: "utf8",
        content: "response-secret",
        sizeBytes: 15,
      },
      timings: {
        startedAt: "2026-09-02T00:00:00.000Z",
        durationMs: 1,
      },
      redirects: [],
      warnings: [],
    });
    expect(responseExport.value.body).toMatchObject({
      kind: "inline",
      content: REDACTED_VALUE,
    });
    expect(responseExport.warnings[0]?.code).toBe(
      "export.response_body_redacted",
    );

    const now = new Date().toISOString();
    const collectionExport = redactCollectionFileForExport({
      schemaVersion: 1,
      exportedAt: now,
      collections: [],
      requests: [textRequest],
    });
    expect(collectionExport.value.requests[0]?.body).toMatchObject({
      text: REDACTED_VALUE,
    });
    expect(collectionExport.warnings[0]?.path).toBe("requests.0.body");
  });
});
