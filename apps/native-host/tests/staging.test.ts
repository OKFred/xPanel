import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { RequestStagingSession } from "../src/staging.js";
import { TRANSFER_CHUNK_LIMIT_BYTES } from "../src/constants.js";

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("request file staging", () => {
  it("assembles ordered chunks, verifies SHA-256, and never uses the client id as a path", async () => {
    const content = Buffer.from("certificate data");
    const hostileId = "../../Windows/System32/drivers/etc/hosts";
    const session = await RequestStagingSession.create("request-files", [
      {
        id: hostileId,
        name: "..\\secret.pem",
        size: content.byteLength,
        sha256: digest(content),
        purpose: "ca",
      },
    ]);
    try {
      await session.accept({
        requestId: "request-files",
        transferId: hostileId,
        sequence: 0,
        data: content.toString("base64"),
        eof: true,
        sha256: digest(content),
      });
      const staged = session.resolve(hostileId, "ca");
      expect(staged.path).toContain(session.directory);
      expect(staged.path).not.toContain("System32");
      expect(await readFile(staged.path)).toEqual(content);
    } finally {
      await session.close();
    }
  });

  it("accepts an identical acknowledged chunk retry without appending it twice", async () => {
    const content = Buffer.from("retry-safe");
    const session = await RequestStagingSession.create("retry", [
      {
        id: "file",
        name: "file.bin",
        size: content.byteLength,
        sha256: digest(content),
        purpose: "multipart",
      },
    ]);
    const chunk = {
      requestId: "retry",
      transferId: "file",
      sequence: 0,
      data: content.toString("base64"),
      eof: true,
      sha256: digest(content),
    };
    try {
      await session.accept(chunk);
      await session.accept(chunk);
      expect((await readFile(session.resolve("file").path)).byteLength).toBe(
        content.byteLength,
      );
    } finally {
      await session.close();
    }
  });

  it("rejects decoded chunks larger than 512 KiB", async () => {
    const content = Buffer.alloc(TRANSFER_CHUNK_LIMIT_BYTES + 1);
    const session = await RequestStagingSession.create("too-large", [
      {
        id: "file",
        name: "file.bin",
        size: content.byteLength,
        sha256: digest(content),
        purpose: "multipart",
      },
    ]);
    try {
      await expect(
        session.accept({
          requestId: "too-large",
          transferId: "file",
          sequence: 0,
          data: content.toString("base64"),
          eof: true,
        }),
      ).rejects.toMatchObject({ code: "CHUNK_TOO_LARGE" });
    } finally {
      await session.close();
    }
  });

  it("assembles a body larger than 512 KiB from bounded chunks", async () => {
    const content = Buffer.alloc(TRANSFER_CHUNK_LIMIT_BYTES + 37, 0x62);
    const contentHash = digest(content);
    const session = await RequestStagingSession.create("large-body", [
      {
        id: "body",
        name: "body.json",
        size: content.byteLength,
        sha256: contentHash,
        purpose: "body",
      },
    ]);
    try {
      await session.accept({
        requestId: "large-body",
        transferId: "body",
        sequence: 0,
        data: content
          .subarray(0, TRANSFER_CHUNK_LIMIT_BYTES)
          .toString("base64"),
        eof: false,
      });
      await session.accept({
        requestId: "large-body",
        transferId: "body",
        sequence: 1,
        data: content.subarray(TRANSFER_CHUNK_LIMIT_BYTES).toString("base64"),
        eof: true,
        sha256: contentHash,
      });
      expect(await readFile(session.resolve("body", "body").path)).toEqual(
        content,
      );
    } finally {
      await session.close();
    }
  });
});
