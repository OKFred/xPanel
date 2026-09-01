import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { emitResponseBody } from "../src/response-body.js";
import { TRANSFER_CHUNK_LIMIT_BYTES } from "../src/constants.js";

describe("chunked native responses", () => {
  it("transfers text whose JSON escaping would exceed the inline envelope budget", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "xpanel-response-control-test-"),
    );
    try {
      const content = Buffer.alloc(192 * 1024, 0);
      const file = path.join(directory, "control.txt");
      await writeFile(file, content);
      const chunks: Buffer[] = [];
      const body = await emitResponseBody(
        "request-control",
        file,
        "text/plain",
        (message) => {
          chunks.push(Buffer.from(message.data, "base64"));
          return Promise.resolve();
        },
      );

      expect(body.kind).toBe("transfer");
      expect(Buffer.concat(chunks)).toEqual(content);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("emits large bodies in decoded chunks no larger than 512 KiB", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "xpanel-response-test-"),
    );
    try {
      const content = Buffer.alloc(TRANSFER_CHUNK_LIMIT_BYTES * 2 + 31, 0x5a);
      const file = path.join(directory, "body.bin");
      await writeFile(file, content);
      const chunks: Buffer[] = [];
      const body = await emitResponseBody(
        "request-large",
        file,
        "application/octet-stream",
        (message) => {
          chunks.push(Buffer.from(message.data, "base64"));
          return Promise.resolve();
        },
      );

      expect(body.kind).toBe("transfer");
      expect(chunks).toHaveLength(3);
      expect(
        chunks.every((chunk) => chunk.byteLength <= TRANSFER_CHUNK_LIMIT_BYTES),
      ).toBe(true);
      expect(Buffer.concat(chunks)).toEqual(content);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
