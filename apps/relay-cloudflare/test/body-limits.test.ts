import {
  REMOTE_MAX_REQUEST_BODY_BYTES,
  REMOTE_MAX_RESPONSE_BODY_BYTES,
} from "@xpanel/contracts";
import { describe, expect, test, vi } from "vitest";

import { readRequestBody } from "../src/body";
import { executeTarget, type Fetcher } from "../src/executor";
import {
  createMetadata,
  executeRelay,
  readRelayError,
  readResponseMetadata,
  toArrayBuffer,
} from "./helpers";

describe("20 MiB body boundaries", () => {
  test("accepts an exactly 20 MiB request body", async () => {
    const bytes = new Uint8Array(REMOTE_MAX_REQUEST_BODY_BYTES);
    bytes[0] = 17;
    bytes[bytes.byteLength - 1] = 29;
    const request = new Request("https://relay.example/v1/execute", {
      method: "POST",
      body: toArrayBuffer(bytes),
    });

    const read = await readRequestBody(
      request,
      REMOTE_MAX_REQUEST_BODY_BYTES,
      "request-limit",
    );

    expect(read.byteLength).toBe(REMOTE_MAX_REQUEST_BODY_BYTES);
    expect(read[0]).toBe(17);
    expect(read[read.byteLength - 1]).toBe(29);
  });

  test("rejects a 20 MiB + 1 request body with payload_too_large", async () => {
    const bytes = new Uint8Array(REMOTE_MAX_REQUEST_BODY_BYTES + 1);
    const request = new Request("https://relay.example/v1/execute", {
      method: "POST",
      body: toArrayBuffer(bytes),
    });

    const pending = readRequestBody(
      request,
      REMOTE_MAX_REQUEST_BODY_BYTES,
      "request-limit",
    );

    await expect(pending).rejects.toMatchObject({
      status: 413,
      code: "payload_too_large",
      requestId: "request-limit",
    });
  });

  test.each([
    {
      expectedCode: "payload_too_large",
      expectedSize: REMOTE_MAX_REQUEST_BODY_BYTES,
      name: "payload_too_large",
      receivedSize: REMOTE_MAX_REQUEST_BODY_BYTES + 1,
      status: 413,
    },
    {
      expectedCode: "invalid_metadata",
      expectedSize: 1,
      name: "invalid_metadata",
      receivedSize: 2,
      status: 400,
    },
  ])(
    "preserves $name when request body cancellation fails",
    async ({ expectedCode, expectedSize, receivedSize, status }) => {
      let cancellationAttempted = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(receivedSize));
        },
        cancel() {
          cancellationAttempted = true;
          throw new Error("synthetic cancellation failure");
        },
      });
      const request = new Request("https://relay.example/v1/execute", {
        method: "POST",
        body: stream,
      });

      await expect(
        readRequestBody(request, expectedSize, "request-cancel-failure"),
      ).rejects.toMatchObject({
        status,
        code: expectedCode,
        requestId: "request-cancel-failure",
      });
      expect(cancellationAttempted).toBe(true);
    },
  );

  test("applies the request timeout while the Relay body is uploading", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("https://relay.example/v1/execute", {
      method: "POST",
      body: stream,
    });

    await expect(
      readRequestBody(request, 1, "upload-timeout", 10),
    ).rejects.toMatchObject({
      status: 504,
      code: "timeout",
      requestId: "upload-timeout",
    });
    expect(cancelled).toBe(true);
  });

  test("returns an exactly 20 MiB upstream response", async () => {
    const bytes = new Uint8Array(REMOTE_MAX_RESPONSE_BODY_BYTES);
    bytes[0] = 31;
    bytes[bytes.byteLength - 1] = 47;
    const fetcher: Fetcher = () =>
      Promise.resolve(new Response(toArrayBuffer(bytes)));

    const response = await executeRelay(fetcher);
    const returned = new Uint8Array(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(returned.byteLength).toBe(REMOTE_MAX_RESPONSE_BODY_BYTES);
    expect(returned[0]).toBe(31);
    expect(returned[returned.byteLength - 1]).toBe(47);
    expect(
      readResponseMetadata(response).declaredBodySizeBytes,
    ).toBeUndefined();
  });

  test("returns response metadata before the upstream body completes", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });

    const response = await Promise.race([
      executeRelay(() => Promise.resolve(new Response(stream))),
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error("Relay buffered the response body.")),
          500,
        );
      }),
    ]);
    const reader = response.body!.getReader();
    streamController.enqueue(Uint8Array.of(11, 12));
    streamController.close();

    await expect(reader.read()).resolves.toMatchObject({
      done: false,
      value: Uint8Array.of(11, 12),
    });
    await expect(reader.read()).resolves.toEqual({ done: true });
  });

  test("rejects a streamed 20 MiB + 1 upstream response", async () => {
    const first = new Uint8Array(REMOTE_MAX_RESPONSE_BODY_BYTES);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(first);
        controller.enqueue(Uint8Array.of(1));
        controller.close();
      },
    });
    const response = await executeRelay(() =>
      Promise.resolve(new Response(stream)),
    );

    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toThrow("response_too_large");
  });

  test("rejects an oversized declared upstream response before buffering it", async () => {
    const response = await executeRelay(() =>
      Promise.resolve(
        new Response(Uint8Array.of(1), {
          headers: {
            "Content-Length": String(REMOTE_MAX_RESPONSE_BODY_BYTES + 1),
          },
        }),
      ),
    );

    expect(response.status).toBe(502);
    await expect(readRelayError(response)).resolves.toMatchObject({
      error: { code: "response_too_large" },
    });
  });

  test("preserves response_too_large when upstream cancellation fails", async () => {
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        throw new Error("synthetic cancellation failure");
      },
    });
    const response = await executeRelay(() =>
      Promise.resolve(
        new Response(stream, {
          headers: {
            "Content-Length": String(REMOTE_MAX_RESPONSE_BODY_BYTES + 1),
          },
        }),
      ),
    );

    expect(response.status).toBe(502);
    await expect(readRelayError(response)).resolves.toMatchObject({
      error: { code: "response_too_large" },
    });
  });

  test("cleans the abort listener and timeout when finalizing a response fails", async () => {
    const incomingSignal = new AbortController().signal;
    const addListener = vi.spyOn(incomingSignal, "addEventListener");
    const removeListener = vi.spyOn(incomingSignal, "removeEventListener");
    const setTimer = vi.spyOn(globalThis, "setTimeout");
    const clearTimer = vi.spyOn(globalThis, "clearTimeout");

    try {
      const pending = executeTarget(
        createMetadata(),
        new Uint8Array(),
        {
          kind: "allowlist",
          origins: new Set(["https://api.example.com"]),
        },
        "https://relay.example.workers.dev",
        incomingSignal,
        () =>
          Promise.resolve(
            new Response(Uint8Array.of(1), {
              headers: {
                "Content-Length": String(REMOTE_MAX_RESPONSE_BODY_BYTES + 1),
              },
            }),
          ),
      );

      await expect(pending).rejects.toMatchObject({
        code: "response_too_large",
      });
      const abortListener = addListener.mock.calls.find(
        ([type]) => type === "abort",
      )?.[1];
      expect(abortListener).toBeDefined();
      expect(removeListener).toHaveBeenCalledExactlyOnceWith(
        "abort",
        abortListener,
      );
      expect(setTimer).toHaveBeenCalledExactlyOnceWith(
        expect.any(Function),
        60_000,
      );
      const timeoutHandle = setTimer.mock.results[0]?.value as unknown;
      expect(timeoutHandle).toBeDefined();
      expect(clearTimer).toHaveBeenCalledExactlyOnceWith(timeoutHandle);
    } finally {
      clearTimer.mockRestore();
      setTimer.mockRestore();
      removeListener.mockRestore();
      addListener.mockRestore();
    }
  });

  test("does not treat a bodyless HEAD representation length as transferred bytes", async () => {
    const response = await executeRelay(
      () =>
        Promise.resolve(
          new Response(null, {
            headers: {
              "Content-Length": String(REMOTE_MAX_RESPONSE_BODY_BYTES + 1),
            },
          }),
        ),
      createMetadata({ method: "HEAD" }),
    );

    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
    expect(readResponseMetadata(response).declaredBodySizeBytes).toBe(0);
  });

  test("cancels upstream when response metadata exceeds 48 KiB", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const response = await executeRelay(() =>
      Promise.resolve(
        new Response(body, {
          headers: { "X-Large": "a".repeat(49 * 1024) },
        }),
      ),
    );

    expect(response.status).toBe(502);
    await expect(readRelayError(response)).resolves.toMatchObject({
      error: { code: "metadata_too_large" },
    });
    expect(cancelled).toBe(true);
  });

  test("uses invalid_metadata when actual request size differs from metadata", async () => {
    const body = new TextEncoder().encode("12345");
    const response = await executeRelay(
      () => Promise.resolve(new Response("must not happen")),
      createMetadata({
        method: "POST",
        bodySizeBytes: body.byteLength - 1,
      }),
      body,
    );

    expect(response.status).toBe(400);
    await expect(readRelayError(response)).resolves.toMatchObject({
      requestId: "request-1",
      error: { code: "invalid_metadata" },
    });
  });
});
