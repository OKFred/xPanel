import { createHash, randomUUID, type Hash } from "node:crypto";
import { open, mkdtemp, rm, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_TRANSFER_BYTES, TRANSFER_CHUNK_LIMIT_BYTES } from "./constants.js";
import { NativeHostError } from "./errors.js";

export const FILE_PURPOSES = [
  "body",
  "multipart",
  "ca",
  "clientCert",
  "clientKey",
] as const;
export type FilePurpose = (typeof FILE_PURPOSES)[number];

export interface NativeFileDescriptor {
  id: string;
  name: string;
  size: number;
  sha256: string;
  purpose: FilePurpose;
}

export interface IncomingTransferChunk {
  requestId: string;
  transferId: string;
  sequence: number;
  data: string;
  eof: boolean;
  sha256?: string;
}

interface TransferState {
  readonly descriptor: NativeFileDescriptor;
  readonly path: string;
  readonly handle: FileHandle;
  readonly hash: Hash;
  readonly chunkHashes: Map<number, string>;
  bytesWritten: number;
  nextSequence: number;
  complete: boolean;
}

export interface StagedFile {
  id: string;
  name: string;
  path: string;
  purpose: FilePurpose;
  size: number;
  sha256: string;
}

function decodeBase64(value: string): Buffer {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new NativeHostError(
      "BAD_MESSAGE",
      "Transfer data is not canonical base64.",
    );
  }
  return Buffer.from(value, "base64");
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function isManagedDirectory(directory: string): boolean {
  return (
    path.dirname(directory) === path.resolve(os.tmpdir()) &&
    path.basename(directory).startsWith("xpanel-native-")
  );
}

export class RequestStagingSession {
  public readonly requestId: string;
  public readonly directory: string;
  readonly #transfers: Map<string, TransferState>;
  #closed = false;

  private constructor(
    requestId: string,
    directory: string,
    transfers: Map<string, TransferState>,
  ) {
    this.requestId = requestId;
    this.directory = directory;
    this.#transfers = transfers;
  }

  public static async create(
    requestId: string,
    descriptors: readonly NativeFileDescriptor[],
  ): Promise<RequestStagingSession> {
    const ids = new Set<string>();
    let totalSize = 0;
    for (const descriptor of descriptors) {
      if (ids.has(descriptor.id)) {
        throw new NativeHostError(
          "INVALID_REQUEST",
          `Duplicate file id: ${descriptor.id}`,
        );
      }
      ids.add(descriptor.id);
      if (!Number.isSafeInteger(descriptor.size) || descriptor.size < 0) {
        throw new NativeHostError(
          "INVALID_REQUEST",
          `Invalid size for file ${descriptor.id}.`,
        );
      }
      if (descriptor.size > MAX_TRANSFER_BYTES) {
        throw new NativeHostError(
          "TRANSFER_TOO_LARGE",
          `File ${descriptor.id} exceeds the ${MAX_TRANSFER_BYTES} byte transfer limit.`,
        );
      }
      totalSize += descriptor.size;
      if (totalSize > MAX_TRANSFER_BYTES) {
        throw new NativeHostError(
          "TRANSFER_TOO_LARGE",
          `All request files combined cannot exceed ${MAX_TRANSFER_BYTES} bytes.`,
        );
      }
      if (!isSha256(descriptor.sha256)) {
        throw new NativeHostError(
          "INVALID_REQUEST",
          `Invalid SHA-256 for file ${descriptor.id}.`,
        );
      }
      if (!FILE_PURPOSES.includes(descriptor.purpose)) {
        throw new NativeHostError(
          "INVALID_REQUEST",
          `Invalid purpose for file ${descriptor.id}.`,
        );
      }
    }

    const directory = await mkdtemp(path.join(os.tmpdir(), "xpanel-native-"));
    const transfers = new Map<string, TransferState>();
    try {
      for (const [index, descriptor] of descriptors.entries()) {
        const filePath = path.join(
          directory,
          `attachment-${index}-${randomUUID()}.bin`,
        );
        const handle = await open(filePath, "wx", 0o600);
        transfers.set(descriptor.id, {
          descriptor,
          path: filePath,
          handle,
          hash: createHash("sha256"),
          chunkHashes: new Map(),
          bytesWritten: 0,
          nextSequence: 0,
          complete: false,
        });
      }
      return new RequestStagingSession(requestId, directory, transfers);
    } catch (error) {
      await Promise.allSettled(
        [...transfers.values()].map(async (state) => state.handle.close()),
      );
      if (isManagedDirectory(directory)) {
        await rm(directory, { recursive: true, force: true });
      }
      throw error;
    }
  }

  public get fileCount(): number {
    return this.#transfers.size;
  }

  public get ready(): boolean {
    return [...this.#transfers.values()].every((transfer) => transfer.complete);
  }

  public async accept(chunk: IncomingTransferChunk): Promise<void> {
    this.#assertOpen();
    if (chunk.requestId !== this.requestId) {
      throw new NativeHostError(
        "NOT_FOUND",
        "Chunk request id does not match the staging session.",
      );
    }
    const state = this.#transfers.get(chunk.transferId);
    if (state === undefined) {
      throw new NativeHostError(
        "NOT_FOUND",
        `Unknown transfer id: ${chunk.transferId}`,
      );
    }

    const decoded = decodeBase64(chunk.data);
    if (decoded.byteLength > TRANSFER_CHUNK_LIMIT_BYTES) {
      throw new NativeHostError(
        "CHUNK_TOO_LARGE",
        `A decoded transfer chunk cannot exceed ${TRANSFER_CHUNK_LIMIT_BYTES} bytes.`,
      );
    }
    const chunkHash = createHash("sha256").update(decoded).digest("hex");
    if (chunk.sequence < state.nextSequence) {
      if (state.chunkHashes.get(chunk.sequence) === chunkHash) {
        return;
      }
      throw new NativeHostError(
        "CHUNK_SEQUENCE",
        "A repeated chunk has different content.",
      );
    }
    if (
      chunk.sequence !== state.nextSequence ||
      !Number.isSafeInteger(chunk.sequence)
    ) {
      throw new NativeHostError(
        "CHUNK_SEQUENCE",
        `Expected transfer sequence ${state.nextSequence}; received ${chunk.sequence}.`,
      );
    }
    if (state.complete) {
      throw new NativeHostError(
        "CHUNK_SEQUENCE",
        "Transfer is already complete.",
      );
    }
    if (state.bytesWritten + decoded.byteLength > state.descriptor.size) {
      throw new NativeHostError(
        "TRANSFER_TOO_LARGE",
        "Transfer exceeds its declared size.",
      );
    }

    await state.handle.write(
      decoded,
      0,
      decoded.byteLength,
      state.bytesWritten,
    );
    state.hash.update(decoded);
    state.chunkHashes.set(chunk.sequence, chunkHash);
    state.bytesWritten += decoded.byteLength;
    state.nextSequence += 1;

    if (!chunk.eof) {
      if (state.bytesWritten === state.descriptor.size) {
        throw new NativeHostError(
          "BAD_MESSAGE",
          "Transfer reached its declared size without eof.",
        );
      }
      return;
    }

    if (state.bytesWritten !== state.descriptor.size) {
      throw new NativeHostError(
        "BAD_MESSAGE",
        `Transfer size mismatch: expected ${state.descriptor.size}, received ${state.bytesWritten}.`,
      );
    }
    const digest = state.hash.digest("hex");
    const expected = chunk.sha256 ?? state.descriptor.sha256;
    if (
      digest.toLowerCase() !== expected.toLowerCase() ||
      digest.toLowerCase() !== state.descriptor.sha256.toLowerCase()
    ) {
      throw new NativeHostError(
        "CHUNK_CHECKSUM",
        "Transfer SHA-256 verification failed.",
      );
    }
    await state.handle.close();
    state.complete = true;
  }

  public resolve(
    transferId: string,
    expectedPurpose?: FilePurpose,
  ): StagedFile {
    this.#assertOpen();
    const state = this.#transfers.get(transferId);
    if (state === undefined) {
      throw new NativeHostError(
        "MISSING_FILE",
        `Request references unknown file ${transferId}.`,
      );
    }
    if (!state.complete) {
      throw new NativeHostError(
        "FILE_NOT_READY",
        `File ${transferId} has not finished uploading.`,
      );
    }
    if (
      expectedPurpose !== undefined &&
      state.descriptor.purpose !== expectedPurpose
    ) {
      throw new NativeHostError(
        "INVALID_REQUEST",
        `File ${transferId} cannot be used as ${expectedPurpose}.`,
      );
    }
    return {
      id: state.descriptor.id,
      name: state.descriptor.name,
      path: state.path,
      purpose: state.descriptor.purpose,
      size: state.descriptor.size,
      sha256: state.descriptor.sha256,
    };
  }

  public async createGeneratedFile(
    content: string | Uint8Array = new Uint8Array(),
  ): Promise<string> {
    this.#assertOpen();
    const filePath = path.join(this.directory, `generated-${randomUUID()}.bin`);
    const handle = await open(filePath, "wx", 0o600);
    try {
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
    return filePath;
  }

  public async openGeneratedFile(): Promise<{
    handle: FileHandle;
    path: string;
  }> {
    this.#assertOpen();
    const filePath = path.join(this.directory, `generated-${randomUUID()}.bin`);
    const handle = await open(filePath, "wx", 0o600);
    return { handle, path: filePath };
  }

  public async removeGeneratedFiles(
    filePaths: readonly string[],
  ): Promise<void> {
    this.#assertOpen();
    for (const filePath of new Set(filePaths)) {
      const resolved = path.resolve(filePath);
      if (
        path.dirname(resolved) !== path.resolve(this.directory) ||
        !path.basename(resolved).startsWith("generated-")
      ) {
        throw new NativeHostError(
          "INTERNAL_ERROR",
          `Refusing to remove an unmanaged generated file: ${filePath}`,
        );
      }
      await rm(resolved, { force: true });
    }
  }

  public async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await Promise.allSettled(
      [...this.#transfers.values()]
        .filter((state) => !state.complete)
        .map(async (state) => state.handle.close()),
    );
    if (!isManagedDirectory(this.directory)) {
      throw new NativeHostError(
        "INTERNAL_ERROR",
        `Refusing to clean an unmanaged staging directory: ${this.directory}`,
      );
    }
    await rm(this.directory, { recursive: true, force: true });
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new NativeHostError("NOT_FOUND", "Staging session is closed.");
    }
  }
}
