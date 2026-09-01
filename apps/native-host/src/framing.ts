import { Transform, type TransformCallback, type Writable } from "node:stream";
import { once } from "node:events";
import { NativeHostError } from "./errors.js";
import { NATIVE_MESSAGE_LIMIT_BYTES } from "./constants.js";

export function encodeNativeMessage(
  message: unknown,
  maximumBytes = NATIVE_MESSAGE_LIMIT_BYTES,
): Buffer {
  let payload: Buffer;
  try {
    payload = Buffer.from(JSON.stringify(message), "utf8");
  } catch (error) {
    throw new NativeHostError(
      "BAD_MESSAGE",
      "Native message is not JSON serializable.",
      {
        cause: error,
      },
    );
  }

  if (payload.byteLength === 0 || payload.byteLength > maximumBytes) {
    throw new NativeHostError(
      "BAD_FRAME",
      `Native message payload must be between 1 and ${maximumBytes} bytes.`,
      { details: { payloadBytes: payload.byteLength } },
    );
  }

  const frame = Buffer.allocUnsafe(payload.byteLength + 4);
  frame.writeUInt32LE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

export class NativeMessageDecoder extends Transform {
  readonly #maximumBytes: number;
  #buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  public constructor(maximumBytes = NATIVE_MESSAGE_LIMIT_BYTES) {
    super({ readableObjectMode: true });
    this.#maximumBytes = maximumBytes;
  }

  public override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      const nextChunk = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk, encoding);
      this.#buffer =
        this.#buffer.byteLength === 0
          ? nextChunk
          : Buffer.concat([this.#buffer, nextChunk]);

      while (this.#buffer.byteLength >= 4) {
        const payloadLength = this.#buffer.readUInt32LE(0);
        if (payloadLength === 0 || payloadLength > this.#maximumBytes) {
          throw new NativeHostError(
            "BAD_FRAME",
            `Native frame declares an invalid payload length of ${payloadLength} bytes.`,
          );
        }
        if (this.#buffer.byteLength < payloadLength + 4) {
          break;
        }

        const payload = this.#buffer.subarray(4, payloadLength + 4);
        this.#buffer = this.#buffer.subarray(payloadLength + 4);
        try {
          this.push(JSON.parse(payload.toString("utf8")));
        } catch (error) {
          throw new NativeHostError(
            "BAD_MESSAGE",
            "Native frame contains invalid JSON.",
            {
              cause: error,
            },
          );
        }
      }
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  public override _flush(callback: TransformCallback): void {
    if (this.#buffer.byteLength !== 0) {
      callback(
        new NativeHostError(
          "BAD_FRAME",
          "Native input ended with an incomplete frame.",
        ),
      );
      return;
    }
    callback();
  }
}

async function writeFrame(target: Writable, frame: Buffer): Promise<void> {
  if (target.write(frame)) {
    return;
  }
  await once(target, "drain");
}

export class NativeMessageWriter {
  readonly #target: Writable;
  #tail: Promise<void> = Promise.resolve();

  public constructor(target: Writable) {
    this.#target = target;
  }

  public send(message: unknown): Promise<void> {
    const frame = encodeNativeMessage(message);
    this.#tail = this.#tail.then(async () => writeFrame(this.#target, frame));
    return this.#tail;
  }
}
