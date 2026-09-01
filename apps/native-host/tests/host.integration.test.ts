import { once } from "node:events";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { NativeEnvelopeV1 } from "@xpanel/contracts";
import { NativeMessageDecoder } from "../src/framing.js";
import { NativeHost } from "../src/host.js";
import { requestFixture } from "./fixtures.js";

function waitForMessage(
  messages: NativeEnvelopeV1[],
  decoder: NativeMessageDecoder,
  predicate: (message: NativeEnvelopeV1) => boolean,
): Promise<NativeEnvelopeV1> {
  const existing = messages.find(predicate);
  if (existing !== undefined) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const listener = (message: NativeEnvelopeV1): void => {
      if (!predicate(message)) return;
      decoder.off("data", listener);
      resolve(message);
    };
    decoder.on("data", listener);
  });
}

describe("native host and system curl", () => {
  it("executes a structured local request and returns a validated complete envelope", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ method: request.method, url: request.url }),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Expected TCP server address.");

    const output = new PassThrough();
    const decoder = new NativeMessageDecoder();
    const messages: NativeEnvelopeV1[] = [];
    output.pipe(decoder);
    decoder.on("data", (message: NativeEnvelopeV1) => messages.push(message));
    const host = new NativeHost(output);
    try {
      const request = requestFixture({
        id: "integration-request",
        url: `http://127.0.0.1:${address.port}/fixture`,
      });
      await host.handle({
        version: 1,
        id: "execute-1",
        type: "execute",
        request,
      });
      const complete = await waitForMessage(
        messages,
        decoder,
        (message) =>
          message.type === "complete" && message.requestId === request.id,
      );
      expect(complete.type).toBe("complete");
      if (complete.type !== "complete") return;
      expect(complete.response.status).toBe(200);
      expect(complete.response.executor).toBe("native");
      expect(complete.response.body).toMatchObject({
        kind: "inline",
        encoding: "utf8",
      });
    } finally {
      await host.close();
      server.close();
      await once(server, "close");
    }
  });

  it("waits for an ACK before sending each large response chunk", async () => {
    const responseBytes = Buffer.alloc(700 * 1024, 0x78);
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/octet-stream");
      response.end(responseBytes);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Expected TCP server address.");

    const output = new PassThrough();
    const decoder = new NativeMessageDecoder();
    output.pipe(decoder);
    const host = new NativeHost(output);
    const chunks: Extract<NativeEnvelopeV1, { type: "chunk" }>[] = [];
    const completed = new Promise<
      Extract<NativeEnvelopeV1, { type: "complete" }>
    >((resolve, reject) => {
      decoder.on("data", (message: NativeEnvelopeV1) => {
        if (message.type === "chunk") {
          chunks.push(message);
          host
            .handle({
              version: 1,
              id: `ack-${message.sequence}`,
              type: "ack",
              requestId: message.requestId,
              transferId: message.transferId,
              sequence: message.sequence,
              phase: "chunk",
            })
            .catch(reject);
        } else if (message.type === "complete") {
          resolve(message);
        } else if (message.type === "error") {
          reject(new Error(`${message.code}: ${message.message}`));
        }
      });
    });

    try {
      await host.handle({
        version: 1,
        id: "execute-large",
        type: "execute",
        request: requestFixture({
          id: "integration-large",
          url: `http://127.0.0.1:${address.port}/large`,
        }),
      });
      const complete = await completed;
      expect(chunks.map((chunk) => chunk.sequence)).toEqual([0, 1]);
      expect(chunks[0]?.eof).toBe(false);
      expect(chunks[1]?.eof).toBe(true);
      expect(chunks[1]?.sha256).toMatch(/^[a-f\d]{64}$/);
      expect(
        Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.data, "base64"))),
      ).toEqual(responseBytes);
      expect(complete.response.body).toMatchObject({
        kind: "transfer",
        transferId: chunks[0]?.transferId,
        sizeBytes: responseBytes.byteLength,
      });
    } finally {
      await host.close();
      server.close();
      await once(server, "close");
    }
  });

  it("starts raw file-body execution only after the upload is ACKed and verified", async () => {
    let received = Buffer.alloc(0);
    const server = createServer((request, response) => {
      const parts: Buffer[] = [];
      request.on("data", (part: Buffer) => parts.push(part));
      request.on("end", () => {
        received = Buffer.concat(parts);
        response.setHeader("content-type", "text/plain");
        response.end("uploaded");
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Expected TCP server address.");

    const fileBytes = Buffer.from("selected-file-content");
    const fileHash = createHash("sha256").update(fileBytes).digest("hex");
    const output = new PassThrough();
    const decoder = new NativeMessageDecoder();
    const messages: NativeEnvelopeV1[] = [];
    output.pipe(decoder);
    decoder.on("data", (message: NativeEnvelopeV1) => messages.push(message));
    const host = new NativeHost(output);
    try {
      const request = requestFixture({
        id: "integration-upload",
        method: "POST",
        url: `http://127.0.0.1:${address.port}/upload`,
        body: {
          kind: "file",
          file: {
            id: "selected-file",
            name: "payload.txt",
            size: fileBytes.byteLength,
            sha256: fileHash,
            pathHint: "C:\\must-not-be-read.txt",
            requiresReselection: true,
          },
          mediaType: "application/octet-stream",
        },
      });
      await host.handle({
        version: 1,
        id: "execute-upload",
        type: "execute",
        request,
        files: [
          {
            id: "selected-file",
            name: "payload.txt",
            size: fileBytes.byteLength,
            sha256: fileHash,
            purpose: "body",
          },
        ],
      });
      expect(
        messages.some(
          (message) =>
            message.type === "ack" &&
            message.phase === "ready" &&
            message.requestId === request.id,
        ),
      ).toBe(true);
      expect(messages.some((message) => message.type === "complete")).toBe(
        false,
      );

      await host.handle({
        version: 1,
        id: "upload-chunk-0",
        type: "chunk",
        requestId: request.id,
        transferId: "selected-file",
        sequence: 0,
        data: fileBytes.toString("base64"),
        eof: true,
        sha256: fileHash,
      });
      const complete = await waitForMessage(
        messages,
        decoder,
        (message) =>
          message.type === "complete" && message.requestId === request.id,
      );
      expect(complete.type).toBe("complete");
      expect(received).toEqual(fileBytes);
      expect(
        messages.some(
          (message) =>
            message.type === "ack" &&
            message.phase === "chunk" &&
            message.transferId === "selected-file" &&
            message.sequence === 0,
        ),
      ).toBe(true);
    } finally {
      await host.close();
      server.close();
      await once(server, "close");
    }
  });

  it("does not forward any user header or structured credential to a redirected origin", async () => {
    let firstHeaders: Record<string, string | string[] | undefined> = {};
    let secondHeaders: Record<string, string | string[] | undefined> = {};
    const second = createServer((request, response) => {
      secondHeaders = request.headers;
      response.setHeader("content-type", "text/plain");
      response.end("final");
    });
    second.listen(0, "127.0.0.1");
    await once(second, "listening");
    const secondAddress = second.address();
    if (secondAddress === null || typeof secondAddress === "string")
      throw new Error("Expected second TCP server address.");

    const first = createServer((request, response) => {
      firstHeaders = request.headers;
      response.statusCode = 302;
      response.setHeader(
        "location",
        `http://127.0.0.1:${secondAddress.port}/final`,
      );
      response.end();
    });
    first.listen(0, "127.0.0.1");
    await once(first, "listening");
    const firstAddress = first.address();
    if (firstAddress === null || typeof firstAddress === "string")
      throw new Error("Expected first TCP server address.");

    const output = new PassThrough();
    const decoder = new NativeMessageDecoder();
    const messages: NativeEnvelopeV1[] = [];
    output.pipe(decoder);
    decoder.on("data", (message: NativeEnvelopeV1) => messages.push(message));
    const host = new NativeHost(output);
    try {
      const request = requestFixture({
        id: "cross-origin-redirect",
        url: `http://127.0.0.1:${firstAddress.port}/start`,
        headers: [
          { name: "X-API-Key", value: "header-secret", enabled: true },
          { name: "Cookie", value: "session=cookie-secret", enabled: true },
          { name: "X-Custom-Metadata", value: "origin-scoped", enabled: true },
        ],
        auth: { kind: "bearer", token: "bearer-secret" },
        options: {
          redirect: "follow",
          cookieMode: "omit",
          timeoutMs: 5_000,
          proxy: null,
          tls: { verify: true },
        },
      });
      await host.handle({
        version: 1,
        id: "execute-cross-origin",
        type: "execute",
        request,
      });
      const complete = await waitForMessage(
        messages,
        decoder,
        (message) =>
          message.type === "complete" && message.requestId === request.id,
      );
      expect(firstHeaders["x-api-key"]).toBe("header-secret");
      expect(firstHeaders.authorization).toBe("Bearer bearer-secret");
      expect(firstHeaders.cookie).toBe("session=cookie-secret");
      expect(secondHeaders["x-api-key"]).toBeUndefined();
      expect(secondHeaders.authorization).toBeUndefined();
      expect(secondHeaders.cookie).toBeUndefined();
      expect(secondHeaders["x-custom-metadata"]).toBeUndefined();
      expect(complete.type).toBe("complete");
      if (complete.type === "complete") {
        expect(complete.response.redirects).toMatchObject([
          { status: 302, method: "GET" },
        ]);
      }
    } finally {
      await host.close();
      first.close();
      second.close();
      await Promise.all([once(first, "close"), once(second, "close")]);
    }
  });

  it("blocks cross-origin 307 replay of a JSON secret", async () => {
    let secondRequestCount = 0;
    const second = createServer((_request, response) => {
      secondRequestCount += 1;
      response.end("must not be reached");
    });
    second.listen(0, "127.0.0.1");
    await once(second, "listening");
    const secondAddress = second.address();
    if (secondAddress === null || typeof secondAddress === "string")
      throw new Error("Expected second TCP server address.");

    const first = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.statusCode = 307;
        response.setHeader(
          "location",
          `http://127.0.0.1:${secondAddress.port}/sink`,
        );
        response.end();
      });
    });
    first.listen(0, "127.0.0.1");
    await once(first, "listening");
    const firstAddress = first.address();
    if (firstAddress === null || typeof firstAddress === "string")
      throw new Error("Expected first TCP server address.");

    const output = new PassThrough();
    const decoder = new NativeMessageDecoder();
    const messages: NativeEnvelopeV1[] = [];
    output.pipe(decoder);
    decoder.on("data", (message: NativeEnvelopeV1) => messages.push(message));
    const host = new NativeHost(output);
    try {
      const request = requestFixture({
        id: "blocked-307",
        method: "POST",
        url: `http://127.0.0.1:${firstAddress.port}/start`,
        body: { kind: "json", text: '{"password":"json-secret"}' },
        options: {
          redirect: "follow",
          cookieMode: "omit",
          timeoutMs: 5_000,
          proxy: null,
          tls: { verify: true },
        },
      });
      await host.handle({
        version: 1,
        id: "execute-blocked-307",
        type: "execute",
        request,
      });
      const error = await waitForMessage(
        messages,
        decoder,
        (message) =>
          message.type === "error" && message.requestId === request.id,
      );
      expect(error).toMatchObject({
        type: "error",
        code: "CURL_FAILED",
        requestId: request.id,
      });
      expect(secondRequestCount).toBe(0);
    } finally {
      await host.close();
      first.close();
      second.close();
      await Promise.all([once(first, "close"), once(second, "close")]);
    }
  });

  it("resolves multi-hop relative redirects against each hop and updates POST to GET", async () => {
    const observed: Array<{
      method: string | undefined;
      url: string | undefined;
    }> = [];
    const server = createServer((request, response) => {
      observed.push({ method: request.method, url: request.url });
      request.resume();
      request.on("end", () => {
        if (request.url === "/start") {
          response.statusCode = 302;
          response.setHeader("location", "/nested/middle");
        } else if (request.url === "/nested/middle") {
          response.statusCode = 303;
          response.setHeader("location", "final");
        } else {
          response.statusCode = 200;
        }
        response.end();
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Expected TCP server address.");

    const output = new PassThrough();
    const decoder = new NativeMessageDecoder();
    const messages: NativeEnvelopeV1[] = [];
    output.pipe(decoder);
    decoder.on("data", (message: NativeEnvelopeV1) => messages.push(message));
    const host = new NativeHost(output);
    try {
      const request = requestFixture({
        id: "relative-redirects",
        method: "POST",
        url: `http://127.0.0.1:${address.port}/start`,
        body: { kind: "text", text: "first-hop-body" },
        options: {
          redirect: "follow",
          cookieMode: "omit",
          timeoutMs: 5_000,
          proxy: null,
          tls: { verify: true },
        },
      });
      await host.handle({
        version: 1,
        id: "execute-relative",
        type: "execute",
        request,
      });
      const complete = await waitForMessage(
        messages,
        decoder,
        (message) =>
          message.type === "complete" && message.requestId === request.id,
      );
      expect(observed).toEqual([
        { method: "POST", url: "/start" },
        { method: "GET", url: "/nested/middle" },
        { method: "GET", url: "/nested/final" },
      ]);
      expect(complete.type).toBe("complete");
      if (complete.type === "complete") {
        expect(
          complete.response.redirects.map(({ status, method, url }) => ({
            status,
            method,
            url,
          })),
        ).toEqual([
          {
            status: 302,
            method: "POST",
            url: `http://127.0.0.1:${address.port}/nested/middle`,
          },
          {
            status: 303,
            method: "GET",
            url: `http://127.0.0.1:${address.port}/nested/final`,
          },
        ]);
      }
    } finally {
      await host.close();
      server.close();
      await once(server, "close");
    }
  });

  it("rejects an inline request body over 512 KiB before execution", async () => {
    const output = new PassThrough();
    const decoder = new NativeMessageDecoder();
    const messages: NativeEnvelopeV1[] = [];
    output.pipe(decoder);
    decoder.on("data", (message: NativeEnvelopeV1) => messages.push(message));
    const host = new NativeHost(output);
    try {
      await host.handle({
        version: 1,
        id: "execute-inline-too-large",
        type: "execute",
        request: requestFixture({
          id: "inline-too-large",
          method: "POST",
          body: { kind: "text", text: "x".repeat(512 * 1024 + 1) },
        }),
      });
      expect(messages).toContainEqual(
        expect.objectContaining({
          type: "error",
          requestId: "inline-too-large",
          code: "INLINE_BODY_REQUIRES_TRANSFER",
        }),
      );
    } finally {
      await host.close();
    }
  });

  it("expires an orphaned upload that stops after execute", async () => {
    const output = new PassThrough();
    const decoder = new NativeMessageDecoder();
    const messages: NativeEnvelopeV1[] = [];
    output.pipe(decoder);
    decoder.on("data", (message: NativeEnvelopeV1) => messages.push(message));
    const host = new NativeHost(output, { uploadIdleTimeoutMs: 20 });
    const emptyHash = createHash("sha256").update("waiting").digest("hex");
    try {
      const request = requestFixture({
        id: "orphaned-upload",
        method: "POST",
        body: {
          kind: "file",
          file: {
            id: "waiting-body",
            name: "body.bin",
            size: 7,
            sha256: emptyHash,
            requiresReselection: true,
          },
        },
      });
      await host.handle({
        version: 1,
        id: "execute-orphaned",
        type: "execute",
        request,
        files: [
          {
            id: "waiting-body",
            name: "body.bin",
            size: 7,
            sha256: emptyHash,
            purpose: "body",
          },
        ],
      });
      const error = await waitForMessage(
        messages,
        decoder,
        (message) =>
          message.type === "error" && message.requestId === request.id,
      );
      expect(error).toMatchObject({
        type: "error",
        code: "UPLOAD_TIMEOUT",
        requestId: request.id,
        retryable: true,
      });
    } finally {
      await host.close();
    }
  });
});
