import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { encodeNativeMessage, NativeMessageDecoder } from "../src/framing.js";
import { NativeHostError } from "../src/errors.js";
import {
  NATIVE_MESSAGE_LIMIT_BYTES,
  TRANSFER_CHUNK_LIMIT_BYTES,
} from "../src/constants.js";

describe("native messaging framing", () => {
  it("decodes fragmented and coalesced length-prefixed JSON frames", async () => {
    const first = encodeNativeMessage({ type: "first", value: 1 });
    const second = encodeNativeMessage({ type: "second", value: 2 });
    const combined = Buffer.concat([first, second]);
    const decoder = new NativeMessageDecoder();
    const messages: unknown[] = [];
    decoder.on("data", (message: unknown) => messages.push(message));

    decoder.write(combined.subarray(0, 2));
    decoder.write(combined.subarray(2, 11));
    decoder.end(combined.subarray(11));
    await once(decoder, "end");

    expect(messages).toEqual([
      { type: "first", value: 1 },
      { type: "second", value: 2 },
    ]);
  });

  it("rejects payloads over the native message limit", () => {
    expect(() => encodeNativeMessage({ value: "x".repeat(200) }, 64)).toThrow(
      NativeHostError,
    );
  });

  it("rejects invalid declared frame lengths before allocating payload memory", async () => {
    const decoder = new NativeMessageDecoder(32);
    const error = new Promise<Error>((resolve) =>
      decoder.once("error", resolve),
    );
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(33);
    decoder.end(prefix);
    const caught = await error;
    expect(caught).toBeInstanceOf(NativeHostError);
  });

  it("fits a maximum decoded transfer chunk but rejects a 1 MiB inline body", () => {
    const chunkFrame = encodeNativeMessage({
      version: 1,
      id: "chunk-boundary",
      type: "chunk",
      requestId: "request-boundary",
      transferId: "body",
      sequence: 0,
      data: Buffer.alloc(TRANSFER_CHUNK_LIMIT_BYTES).toString("base64"),
      eof: true,
    });
    expect(chunkFrame.byteLength).toBeLessThanOrEqual(
      NATIVE_MESSAGE_LIMIT_BYTES + 4,
    );
    expect(() =>
      encodeNativeMessage({
        version: 1,
        id: "execute-too-large",
        type: "execute",
        request: { body: { kind: "text", text: "x".repeat(1024 * 1024) } },
      }),
    ).toThrow(/Native message payload/);
  });
});
