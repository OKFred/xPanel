import { REMOTE_MAX_REQUEST_BODY_BYTES } from "@xpanel/contracts";
import { RelayError } from "./errors";

export async function readRequestBody(
  request: Request,
  expectedSize: number,
  requestId: string,
  timeoutMs?: number,
): Promise<Uint8Array> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && /^\d+$/u.test(contentLength)) {
    const declared = Number(contentLength);
    if (declared > REMOTE_MAX_REQUEST_BODY_BYTES) {
      throw new RelayError(
        413,
        "payload_too_large",
        "The request body exceeds the relay limit.",
        requestId,
      );
    }
    if (Number.isSafeInteger(declared) && declared !== expectedSize) {
      throw new RelayError(
        400,
        "invalid_metadata",
        "The request body size does not match its metadata.",
        requestId,
      );
    }
  }

  if (request.body === null) {
    if (expectedSize !== 0) {
      throw new RelayError(
        400,
        "invalid_metadata",
        "The request body size does not match its metadata.",
        requestId,
      );
    }
    return new Uint8Array();
  }

  const reader = request.body.getReader();
  const body = new Uint8Array(expectedSize);
  let received = 0;
  let timedOut = false;
  const timeout =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          void reader.cancel("timeout").catch(() => undefined);
        }, timeoutMs);
  try {
    for (;;) {
      if (timedOut) {
        throw new RelayError(
          504,
          "timeout",
          "The relay request upload timed out.",
          requestId,
        );
      }
      if (request.signal.aborted) {
        throw new RelayError(
          499,
          "cancelled",
          "The relay request was cancelled.",
          requestId,
        );
      }
      const result = await reader.read();
      if (timedOut) {
        throw new RelayError(
          504,
          "timeout",
          "The relay request upload timed out.",
          requestId,
        );
      }
      if (result.done) break;
      const nextReceived = received + result.value.byteLength;
      if (nextReceived > REMOTE_MAX_REQUEST_BODY_BYTES) {
        await reader.cancel("payload_too_large");
        throw new RelayError(
          413,
          "payload_too_large",
          "The request body exceeds the relay limit.",
          requestId,
        );
      }
      if (nextReceived > expectedSize) {
        await reader.cancel("invalid_metadata");
        throw new RelayError(
          400,
          "invalid_metadata",
          "The request body size does not match its metadata.",
          requestId,
        );
      }
      body.set(result.value, received);
      received = nextReceived;
    }
  } catch (error) {
    if (error instanceof RelayError) throw error;
    if (timedOut) {
      throw new RelayError(
        504,
        "timeout",
        "The relay request upload timed out.",
        requestId,
      );
    }
    if (request.signal.aborted) {
      throw new RelayError(
        499,
        "cancelled",
        "The relay request was cancelled.",
        requestId,
      );
    }
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }

  if (received !== expectedSize) {
    throw new RelayError(
      400,
      "invalid_metadata",
      "The request body size does not match its metadata.",
      requestId,
    );
  }

  return body;
}
