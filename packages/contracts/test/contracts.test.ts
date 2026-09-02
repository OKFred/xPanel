import { describe, expect, it } from "vitest";

import {
  CollectionFileV1Schema,
  DEFAULT_REQUEST_TIMEOUT_MS,
  ExecutionProgressV1Schema,
  ExecutorV1Schema,
  REDACTED_VALUE,
  REMOTE_ERROR_CODES,
  REMOTE_MAX_METADATA_BYTES,
  REMOTE_MAX_REQUEST_BODY_BYTES,
  REMOTE_MAX_RESPONSE_BODY_BYTES,
  REMOTE_PROTOCOL_VERSION,
  RelayHeaderV1Schema,
  RemoteCapabilitiesV1Schema,
  RemoteErrorEnvelopeV1Schema,
  RemoteRelayProfileV1Schema,
  RemoteRequestMetaV1Schema,
  RemoteResponseMetaV1Schema,
  RequestSpecV1Schema,
  ResponseRecordV1Schema,
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
      options: {
        timeoutMs: 60_000,
        proxy: null,
        tls: { verify: true },
      },
    });
    expect(request.options.timeoutMs).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
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

describe("Remote Relay V1", () => {
  const requestMeta = {
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    requestId: "request-remote-1",
    method: "POST",
    url: "https://api.example.com/v1/items?q=x",
    headers: [
      { name: "Cookie", value: "session=secret" },
      { name: "X-Trace", value: "one" },
      { name: "X-Trace", value: "two" },
    ],
    redirect: "follow" as const,
    timeoutMs: 60_000,
    bodySizeBytes: 12,
  };

  const responseMeta = {
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    requestId: "request-remote-1",
    status: 200,
    statusText: "OK",
    headers: [
      { name: "Set-Cookie", value: "a=1; Path=/" },
      { name: "Set-Cookie", value: "b=2; Path=/" },
    ],
    redirects: [],
    upstreamDurationMs: 42.5,
    declaredBodySizeBytes: 2,
    warnings: [],
  };

  it("exports fixed protocol and transport limits", () => {
    expect(REMOTE_PROTOCOL_VERSION).toBe(1);
    expect(REMOTE_MAX_METADATA_BYTES).toBe(49_152);
    expect(REMOTE_MAX_REQUEST_BODY_BYTES).toBe(20_971_520);
    expect(REMOTE_MAX_RESPONSE_BODY_BYTES).toBe(20_971_520);
  });

  it("validates executor values and accepts remote response records", () => {
    expect(ExecutorV1Schema.parse("browser")).toBe("browser");
    expect(ExecutorV1Schema.parse("remote")).toBe("remote");
    expect(ExecutorV1Schema.safeParse("native").success).toBe(false);

    expect(
      ResponseRecordV1Schema.parse({
        requestId: "request-remote-1",
        executor: "remote",
        status: 200,
        statusText: "OK",
        headers: [],
        body: {
          kind: "inline",
          encoding: "utf8",
          content: "{}",
          sizeBytes: 2,
        },
        timings: {
          startedAt: "2026-09-02T00:00:00.000Z",
          durationMs: 50,
          requestMs: 42.5,
        },
        redirects: [],
        warnings: [],
      }).executor,
    ).toBe("remote");
  });

  it("validates every strict execution progress phase", () => {
    for (const phase of [
      "preparing",
      "requesting-permission",
      "uploading",
      "waiting",
      "downloading",
      "cancelling",
      "complete",
    ] as const) {
      expect(
        ExecutionProgressV1Schema.parse({
          phase,
          loadedBytes: 1,
          totalBytes: 2,
          elapsedMs: 3.5,
        }).phase,
      ).toBe(phase);
    }
    expect(
      ExecutionProgressV1Schema.safeParse({
        phase: "retrying",
        loadedBytes: 0,
        elapsedMs: 0,
      }).success,
    ).toBe(false);
    expect(
      ExecutionProgressV1Schema.safeParse({
        phase: "waiting",
        loadedBytes: -1,
        elapsedMs: 0,
      }).success,
    ).toBe(false);
    expect(
      ExecutionProgressV1Schema.safeParse({
        phase: "waiting",
        loadedBytes: 0,
        elapsedMs: 0,
        requestId: "not-part-of-progress",
      }).success,
    ).toBe(false);
  });

  it("validates strict relay profiles without persisting a token", () => {
    const profile = {
      schemaVersion: 1,
      id: "relay-1",
      name: "My relay",
      baseUrl: "https://relay.example.com/xpanel",
      tokenStorage: "session" as const,
    };
    expect(RemoteRelayProfileV1Schema.parse(profile)).toEqual(profile);
    expect(
      RemoteRelayProfileV1Schema.safeParse({ ...profile, token: "secret" })
        .success,
    ).toBe(false);
    expect(
      RemoteRelayProfileV1Schema.safeParse({
        ...profile,
        baseUrl: "http://relay.example.com/xpanel",
      }).success,
    ).toBe(false);
    for (const baseUrl of [
      "https://user:pass@relay.example.com/xpanel",
      "https://relay.example.com/xpanel?token=secret",
      "https://relay.example.com/xpanel?",
      "https://relay.example.com/xpanel#settings",
      "https://relay.example.com/xpanel#",
    ]) {
      expect(
        RemoteRelayProfileV1Schema.safeParse({ ...profile, baseUrl }).success,
      ).toBe(false);
    }
  });

  it("validates request metadata while preserving duplicate headers", () => {
    expect(RemoteRequestMetaV1Schema.parse(requestMeta)).toEqual(requestMeta);
    expect(
      RemoteRequestMetaV1Schema.safeParse({
        ...requestMeta,
        bodySizeBytes: REMOTE_MAX_REQUEST_BODY_BYTES + 1,
      }).success,
    ).toBe(false);
    expect(
      RemoteRequestMetaV1Schema.safeParse({
        ...requestMeta,
        protocolVersion: 2,
      }).success,
    ).toBe(false);
    expect(
      RemoteRequestMetaV1Schema.safeParse({
        ...requestMeta,
        source: { format: "manual" },
      }).success,
    ).toBe(false);
  });

  it("rejects malformed relay headers and header injection", () => {
    expect(RelayHeaderV1Schema.parse({ name: "X-Trace", value: "ok" })).toEqual(
      { name: "X-Trace", value: "ok" },
    );
    expect(
      RelayHeaderV1Schema.safeParse({ name: "Bad Header", value: "ok" })
        .success,
    ).toBe(false);
    expect(
      RelayHeaderV1Schema.safeParse({
        name: "X-Trace",
        value: "ok\r\nInjected: yes",
      }).success,
    ).toBe(false);
    expect(
      RelayHeaderV1Schema.safeParse({
        name: "X-Trace",
        value: "ok",
        enabled: true,
      }).success,
    ).toBe(false);
  });

  it("validates response metadata and separate Set-Cookie values", () => {
    expect(RemoteResponseMetaV1Schema.parse(responseMeta)).toEqual(
      responseMeta,
    );
    expect(
      RemoteResponseMetaV1Schema.safeParse({
        ...responseMeta,
        declaredBodySizeBytes: REMOTE_MAX_RESPONSE_BODY_BYTES + 1,
      }).success,
    ).toBe(false);
    expect(
      RemoteResponseMetaV1Schema.safeParse({
        ...responseMeta,
        protocolVersion: 99,
      }).success,
    ).toBe(false);
  });

  it("requires the exact Cloudflare capability contract", () => {
    const capabilities = {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      provider: "cloudflare",
      targetPolicy: "allowlist",
      maxMetadataBytes: REMOTE_MAX_METADATA_BYTES,
      maxRequestBodyBytes: REMOTE_MAX_REQUEST_BODY_BYTES,
      maxResponseBodyBytes: REMOTE_MAX_RESPONSE_BODY_BYTES,
      features: {
        explicitCookie: true,
        responseSetCookie: true,
        files: true,
        multipart: true,
        proxy: false,
        customTls: false,
        clientCertificate: false,
      },
    } as const;
    expect(RemoteCapabilitiesV1Schema.parse(capabilities)).toEqual(
      capabilities,
    );
    expect(
      RemoteCapabilitiesV1Schema.safeParse({
        ...capabilities,
        provider: "supabase",
      }).success,
    ).toBe(false);
    expect(
      RemoteCapabilitiesV1Schema.safeParse({
        ...capabilities,
        features: { ...capabilities.features, proxy: true },
      }).success,
    ).toBe(false);
  });

  it("accepts exactly the fixed relay error-code set", () => {
    expect(REMOTE_ERROR_CODES).toHaveLength(14);
    for (const code of REMOTE_ERROR_CODES) {
      expect(
        RemoteErrorEnvelopeV1Schema.parse({
          protocolVersion: REMOTE_PROTOCOL_VERSION,
          requestId: "request-remote-1",
          error: { code, message: `Relay error: ${code}` },
        }).error.code,
      ).toBe(code);
    }
    expect(
      RemoteErrorEnvelopeV1Schema.safeParse({
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        error: { code: "unknown", message: "Unknown error" },
      }).success,
    ).toBe(false);
    expect(
      RemoteErrorEnvelopeV1Schema.safeParse({
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        error: {
          code: "internal",
          message: "Failure",
          details: { token: "must-not-be-returned" },
        },
      }).success,
    ).toBe(false);
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
