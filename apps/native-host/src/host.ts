import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import {
  NativeEnvelopeV1Schema,
  type AckMessage,
  type ChunkMessage,
  type ErrorMessage,
  type ExecuteMessage,
  type FileReferenceV1,
  type NativeEnvelopeV1,
  type NativeFileDescriptorV1,
  type RedirectRecord,
  type RequestSpecV1,
} from "@xpanel/contracts";
import {
  HOST_CAPABILITIES,
  HOST_NAME,
  HOST_VERSION,
  INLINE_REQUEST_BODY_LIMIT_BYTES,
  NATIVE_PROTOCOL_VERSION,
  RESPONSE_ACK_TIMEOUT_MS,
  UPLOAD_IDLE_TIMEOUT_MS,
} from "./constants.js";
import {
  parseCurlResponse,
  prepareCurlRequest,
  redirectedRequest,
  type ParsedCurlResponse,
} from "./curl.js";
import { NativeHostError, toNativeHostError } from "./errors.js";
import { NativeMessageDecoder, NativeMessageWriter } from "./framing.js";
import { emitResponseBody } from "./response-body.js";
import { executeCurl, type ManagedProcess } from "./runner.js";
import {
  RequestStagingSession,
  type FilePurpose,
  type NativeFileDescriptor,
} from "./staging.js";

type OperationPhase = "waiting" | "starting" | "running";

interface Operation {
  readonly message: ExecuteMessage;
  readonly session: RequestStagingSession;
  phase: OperationPhase;
  cancelled: boolean;
  process?: ManagedProcess;
  task?: Promise<void>;
  uploadTimer?: NodeJS.Timeout;
}

export interface NativeHostOptions {
  uploadIdleTimeoutMs?: number;
}

interface RequiredFile {
  readonly reference: FileReferenceV1;
  readonly purpose: FilePurpose;
}

interface PendingResponseAck {
  readonly requestId: string;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

function requiredFiles(message: ExecuteMessage): RequiredFile[] {
  const required: RequiredFile[] = [];
  if (message.request.body.kind === "file") {
    required.push({ reference: message.request.body.file, purpose: "body" });
  } else if (message.request.body.kind === "multipart") {
    for (const part of message.request.body.parts) {
      if (part.enabled && part.kind === "file") {
        required.push({ reference: part.file, purpose: "multipart" });
      }
    }
  }
  const tls = message.request.options.tls;
  if (tls.caFile !== undefined) {
    required.push({ reference: tls.caFile, purpose: "ca" });
  }
  if (tls.clientCertificate !== undefined) {
    required.push({
      reference: tls.clientCertificate.certificate,
      purpose: "clientCert",
    });
    required.push({
      reference: tls.clientCertificate.privateKey,
      purpose: "clientKey",
    });
  }
  return required;
}

function validateFileBindings(message: ExecuteMessage): NativeFileDescriptor[] {
  const descriptors = message.files ?? [];
  const byId = new Map<string, NativeFileDescriptorV1>();
  for (const descriptor of descriptors) {
    if (byId.has(descriptor.id)) {
      throw new NativeHostError(
        "INVALID_REQUEST",
        `Duplicate native file id: ${descriptor.id}`,
      );
    }
    byId.set(descriptor.id, descriptor);
  }

  const usedIds = new Set<string>();
  for (const required of requiredFiles(message)) {
    const descriptor = byId.get(required.reference.id);
    if (descriptor === undefined) {
      throw new NativeHostError(
        "MISSING_FILE",
        `Request requires a freshly uploaded ${required.purpose} file (${required.reference.id}).`,
      );
    }
    if (descriptor.purpose !== required.purpose) {
      throw new NativeHostError(
        "INVALID_REQUEST",
        `File ${descriptor.id} is declared as ${descriptor.purpose}, not ${required.purpose}.`,
      );
    }
    if (
      required.reference.size !== undefined &&
      required.reference.size !== descriptor.size
    ) {
      throw new NativeHostError(
        "INVALID_REQUEST",
        `File ${descriptor.id} size does not match the request.`,
      );
    }
    if (
      required.reference.sha256 !== undefined &&
      required.reference.sha256.toLowerCase() !==
        descriptor.sha256.toLowerCase()
    ) {
      throw new NativeHostError(
        "INVALID_REQUEST",
        `File ${descriptor.id} checksum does not match the request.`,
      );
    }
    usedIds.add(descriptor.id);
  }

  for (const descriptor of descriptors) {
    if (!usedIds.has(descriptor.id)) {
      throw new NativeHostError(
        "INVALID_REQUEST",
        `Uploaded file ${descriptor.id} is not referenced by this request.`,
      );
    }
  }
  return descriptors;
}

function inlineBodyBytes(request: RequestSpecV1): number {
  switch (request.body.kind) {
    case "none":
    case "file":
      return 0;
    case "text":
    case "json":
      return Buffer.byteLength(request.body.text, "utf8");
    case "urlencoded": {
      const form = new URLSearchParams();
      for (const entry of request.body.entries) {
        if (entry.enabled) form.append(entry.name, entry.value);
      }
      return Buffer.byteLength(form.toString(), "utf8");
    }
    case "multipart":
      return request.body.parts.reduce((total, part) => {
        if (!part.enabled || part.kind === "file") return total;
        return (
          total +
          Buffer.byteLength(part.name, "utf8") +
          Buffer.byteLength(part.value, "utf8")
        );
      }, 0);
  }
}

function validateInlineBodySize(request: RequestSpecV1): void {
  const size = inlineBodyBytes(request);
  if (size > INLINE_REQUEST_BODY_LIMIT_BYTES) {
    throw new NativeHostError(
      "INLINE_BODY_REQUIRES_TRANSFER",
      `Inline request body exceeds ${INLINE_REQUEST_BODY_LIMIT_BYTES} bytes; send it as a purpose=body file transfer.`,
      {
        details: {
          bodyBytes: size,
          limitBytes: INLINE_REQUEST_BODY_LIMIT_BYTES,
        },
      },
    );
  }
}

function correlatedRequestId(message: NativeEnvelopeV1): string | undefined {
  if ("requestId" in message) return message.requestId;
  if (message.type === "execute") return message.request.id;
  return undefined;
}

export class NativeHost {
  readonly #writer: NativeMessageWriter;
  readonly #operations = new Map<string, Operation>();
  readonly #responseAcks = new Map<string, PendingResponseAck>();
  readonly #uploadIdleTimeoutMs: number;
  #closed = false;

  public constructor(output: Writable, options: NativeHostOptions = {}) {
    this.#writer = new NativeMessageWriter(output);
    this.#uploadIdleTimeoutMs =
      options.uploadIdleTimeoutMs ?? UPLOAD_IDLE_TIMEOUT_MS;
  }

  public async handle(rawMessage: unknown): Promise<void> {
    const parsed = NativeEnvelopeV1Schema.safeParse(rawMessage);
    if (!parsed.success) {
      await this.#sendError(
        new NativeHostError(
          "BAD_MESSAGE",
          "Message does not match native protocol version 1.",
        ),
      );
      return;
    }
    const message = parsed.data;
    try {
      switch (message.type) {
        case "hello":
          await this.#handleHello();
          return;
        case "execute":
          await this.#handleExecute(message);
          return;
        case "chunk":
          await this.#handleChunk(message);
          return;
        case "cancel":
          await this.#handleCancel(message.requestId);
          return;
        case "ack":
          this.#handleResponseAck(message);
          return;
        case "complete":
        case "error":
          throw new NativeHostError(
            "BAD_MESSAGE",
            `The native host does not accept client ${message.type} messages.`,
          );
      }
    } catch (error) {
      const hostError = toNativeHostError(error);
      await this.#sendError(hostError, correlatedRequestId(message));
      if (message.type === "chunk" && hostError.code === "CHUNK_CHECKSUM") {
        await this.#discardOperation(message.requestId);
      }
    }
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const operations = [...this.#operations.values()];
    for (const operation of operations) {
      operation.cancelled = true;
      this.#clearUploadTimeout(operation);
      operation.process?.cancel();
      this.#rejectResponseAcks(
        operation.message.request.id,
        new NativeHostError("CANCELLED", "Native host is closing."),
      );
    }
    await Promise.allSettled(
      operations.map(async (operation) => operation.task),
    );
    await Promise.allSettled(
      operations.map(async (operation) => operation.session.close()),
    );
    this.#operations.clear();
  }

  public async reportFatal(error: unknown): Promise<void> {
    try {
      await this.#sendError(toNativeHostError(error));
    } catch (sendError) {
      process.stderr.write(
        `xPanel native host could not report fatal error: ${sendError instanceof Error ? sendError.message : String(sendError)}\n`,
      );
    }
  }

  async #handleHello(): Promise<void> {
    await this.#send({
      version: NATIVE_PROTOCOL_VERSION,
      id: randomUUID(),
      type: "hello",
      client: { name: HOST_NAME, version: HOST_VERSION },
      capabilities: [...HOST_CAPABILITIES],
    });
  }

  async #handleExecute(message: ExecuteMessage): Promise<void> {
    const requestId = message.request.id;
    if (this.#operations.has(requestId)) {
      throw new NativeHostError(
        "DUPLICATE_REQUEST",
        `Request ${requestId} is already active.`,
      );
    }
    validateInlineBodySize(message.request);
    const descriptors = validateFileBindings(message);
    const session = await RequestStagingSession.create(requestId, descriptors);
    const operation: Operation = {
      message,
      session,
      phase: "waiting",
      cancelled: false,
    };
    this.#operations.set(requestId, operation);
    await this.#sendAck({ phase: "ready", requestId });
    if (session.ready) {
      this.#start(operation);
    } else {
      this.#armUploadTimeout(operation);
    }
  }

  async #handleChunk(message: ChunkMessage): Promise<void> {
    const operation = this.#operations.get(message.requestId);
    if (operation === undefined || operation.cancelled) {
      throw new NativeHostError(
        "NOT_FOUND",
        `No active request ${message.requestId}.`,
      );
    }
    if (operation.phase !== "waiting") {
      throw new NativeHostError(
        "BAD_MESSAGE",
        "Request is no longer accepting upload chunks.",
      );
    }
    this.#clearUploadTimeout(operation);
    try {
      await operation.session.accept({
        requestId: message.requestId,
        transferId: message.transferId,
        sequence: message.sequence,
        data: message.data,
        eof: message.eof,
        ...(message.sha256 === undefined ? {} : { sha256: message.sha256 }),
      });
      await this.#sendAck({
        phase: "chunk",
        requestId: message.requestId,
        transferId: message.transferId,
        sequence: message.sequence,
      });
      if (operation.session.ready) this.#start(operation);
    } finally {
      if (
        this.#operations.get(message.requestId) === operation &&
        operation.phase === "waiting" &&
        !operation.cancelled &&
        !operation.session.ready
      ) {
        this.#armUploadTimeout(operation);
      }
    }
  }

  async #handleCancel(requestId: string): Promise<void> {
    const operation = this.#operations.get(requestId);
    if (operation === undefined) {
      throw new NativeHostError("NOT_FOUND", `No active request ${requestId}.`);
    }
    operation.cancelled = true;
    this.#clearUploadTimeout(operation);
    operation.process?.cancel();
    this.#rejectResponseAcks(
      requestId,
      new NativeHostError("CANCELLED", "Request was cancelled."),
    );
    await this.#sendAck({ phase: "cancelled", requestId });
    if (operation.task === undefined) {
      this.#operations.delete(requestId);
      await operation.session.close();
    }
  }

  #start(operation: Operation): void {
    if (operation.phase !== "waiting" || operation.cancelled) return;
    this.#clearUploadTimeout(operation);
    operation.phase = "starting";
    operation.task = this.#execute(operation);
  }

  async #execute(operation: Operation): Promise<void> {
    const requestId = operation.message.request.id;
    try {
      const parsed = await this.#executeRedirectChain(operation);
      if (operation.cancelled) {
        throw new NativeHostError("CANCELLED", "Request was cancelled.");
      }
      const body = await emitResponseBody(
        requestId,
        parsed.bodyPath,
        parsed.mediaType,
        async (chunk) => {
          if (operation.cancelled) {
            throw new NativeHostError("CANCELLED", "Request was cancelled.");
          }
          await this.#sendChunkAndWaitForAck(chunk);
        },
      );
      await this.#send({
        version: NATIVE_PROTOCOL_VERSION,
        id: randomUUID(),
        type: "complete",
        requestId,
        response: { ...parsed.response, body },
      });
    } catch (error) {
      const hostError = toNativeHostError(error);
      if (!operation.cancelled && hostError.code !== "CANCELLED") {
        await this.#sendError(hostError, requestId);
      }
    } finally {
      this.#operations.delete(requestId);
      this.#clearUploadTimeout(operation);
      this.#rejectResponseAcks(
        requestId,
        new NativeHostError("CANCELLED", "Request finished."),
      );
      try {
        await operation.session.close();
      } catch (error) {
        process.stderr.write(
          `xPanel native host cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  }

  async #executeRedirectChain(
    operation: Operation,
  ): Promise<ParsedCurlResponse> {
    const originalRequestId = operation.message.request.id;
    let request: RequestSpecV1 = operation.message.request;
    const redirects: RedirectRecord[] = [];

    while (true) {
      const prepared = await prepareCurlRequest(request, operation.session);
      if (operation.cancelled) {
        throw new NativeHostError("CANCELLED", "Request was cancelled.");
      }
      const managedProcess = executeCurl(prepared);
      operation.process = managedProcess;
      operation.phase = "running";
      const processResult = await managedProcess.completion;
      const parsed = await parseCurlResponse(prepared, processResult);
      if (operation.cancelled) {
        throw new NativeHostError("CANCELLED", "Request was cancelled.");
      }

      const location = parsed.response.headers.find(
        (header) => header.name.toLowerCase() === "location",
      )?.value;
      const nextRequest =
        request.options.redirect === "follow" && location !== undefined
          ? redirectedRequest(request, parsed.response.status, location)
          : undefined;
      if (nextRequest === undefined) {
        return {
          ...parsed,
          response: {
            ...parsed.response,
            requestId: originalRequestId,
            redirects,
          },
        };
      }
      if (redirects.length >= 20) {
        throw new NativeHostError(
          "CURL_FAILED",
          "Redirect limit of 20 hops was exceeded.",
        );
      }

      redirects.push({
        url: nextRequest.url,
        status: parsed.response.status,
        method: request.method,
        durationMs: parsed.response.timings.durationMs,
      });
      await operation.session.removeGeneratedFiles(prepared.temporaryPaths);
      request = nextRequest;
    }
  }

  async #discardOperation(requestId: string): Promise<void> {
    const operation = this.#operations.get(requestId);
    if (operation === undefined) return;
    operation.cancelled = true;
    this.#clearUploadTimeout(operation);
    operation.process?.cancel();
    this.#rejectResponseAcks(
      requestId,
      new NativeHostError("CANCELLED", "Request was discarded."),
    );
    this.#operations.delete(requestId);
    await operation.session.close();
  }

  #armUploadTimeout(operation: Operation): void {
    this.#clearUploadTimeout(operation);
    operation.uploadTimer = setTimeout(() => {
      void this.#expireUpload(operation).catch((error: unknown) => {
        process.stderr.write(
          `xPanel native host upload timeout cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });
    }, this.#uploadIdleTimeoutMs);
    operation.uploadTimer.unref();
  }

  #clearUploadTimeout(operation: Operation): void {
    if (operation.uploadTimer === undefined) return;
    clearTimeout(operation.uploadTimer);
    delete operation.uploadTimer;
  }

  async #expireUpload(operation: Operation): Promise<void> {
    const requestId = operation.message.request.id;
    if (
      operation.phase !== "waiting" ||
      operation.cancelled ||
      this.#operations.get(requestId) !== operation
    ) {
      return;
    }
    operation.cancelled = true;
    this.#clearUploadTimeout(operation);
    this.#operations.delete(requestId);
    try {
      await operation.session.close();
    } catch (error) {
      process.stderr.write(
        `xPanel native host expired upload cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    await this.#sendError(
      new NativeHostError(
        "UPLOAD_TIMEOUT",
        "Timed out waiting for the next request body/file chunk.",
        { retryable: true },
      ),
      requestId,
    );
  }

  async #sendAck(
    fields: Omit<AckMessage, "version" | "id" | "type">,
  ): Promise<void> {
    await this.#send({
      version: NATIVE_PROTOCOL_VERSION,
      id: randomUUID(),
      type: "ack",
      ...fields,
    });
  }

  #handleResponseAck(message: AckMessage): void {
    if (
      message.phase !== "chunk" ||
      message.requestId === undefined ||
      message.transferId === undefined ||
      message.sequence === undefined
    ) {
      throw new NativeHostError(
        "BAD_MESSAGE",
        "Response ACK must identify a response chunk.",
      );
    }
    const key = this.#responseAckKey(
      message.requestId,
      message.transferId,
      message.sequence,
    );
    const pending = this.#responseAcks.get(key);
    if (pending === undefined) {
      // ACK retries can arrive after completion or cancellation; they are harmless.
      return;
    }
    clearTimeout(pending.timer);
    this.#responseAcks.delete(key);
    pending.resolve();
  }

  async #sendChunkAndWaitForAck(message: ChunkMessage): Promise<void> {
    const key = this.#responseAckKey(
      message.requestId,
      message.transferId,
      message.sequence,
    );
    if (this.#responseAcks.has(key)) {
      throw new NativeHostError(
        "INTERNAL_ERROR",
        "Duplicate response ACK waiter.",
      );
    }
    let resolvePromise: (() => void) | undefined;
    let rejectPromise: ((error: Error) => void) | undefined;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const timer = setTimeout(() => {
      const pending = this.#responseAcks.get(key);
      if (pending === undefined) return;
      this.#responseAcks.delete(key);
      pending.reject(
        new NativeHostError(
          "ACK_TIMEOUT",
          "Timed out waiting for the response chunk ACK.",
          {
            details: {
              requestId: message.requestId,
              transferId: message.transferId,
              sequence: message.sequence,
            },
            retryable: true,
          },
        ),
      );
    }, RESPONSE_ACK_TIMEOUT_MS);
    timer.unref();
    this.#responseAcks.set(key, {
      requestId: message.requestId,
      resolve: resolvePromise!,
      reject: rejectPromise!,
      timer,
    });
    try {
      await this.#send(message);
      await promise;
    } finally {
      const pending = this.#responseAcks.get(key);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.#responseAcks.delete(key);
      }
    }
  }

  #rejectResponseAcks(requestId: string, error: Error): void {
    for (const [key, pending] of this.#responseAcks) {
      if (pending.requestId !== requestId) continue;
      clearTimeout(pending.timer);
      this.#responseAcks.delete(key);
      pending.reject(error);
    }
  }

  #responseAckKey(
    requestId: string,
    transferId: string,
    sequence: number,
  ): string {
    return `${requestId}\0${transferId}\0${sequence}`;
  }

  async #sendError(error: NativeHostError, requestId?: string): Promise<void> {
    const message: ErrorMessage = {
      version: NATIVE_PROTOCOL_VERSION,
      id: randomUUID(),
      type: "error",
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(requestId === undefined ? {} : { requestId }),
      ...(error.details === undefined ? {} : { details: error.details }),
    };
    await this.#send(message);
  }

  async #send(message: NativeEnvelopeV1): Promise<void> {
    const validated = NativeEnvelopeV1Schema.parse(message);
    await this.#writer.send(validated);
  }
}

export async function runNativeHost(
  input: Readable,
  output: Writable,
): Promise<void> {
  const host = new NativeHost(output);
  const decoder = new NativeMessageDecoder();
  input.pipe(decoder);
  try {
    for await (const message of decoder) {
      await host.handle(message);
    }
  } catch (error) {
    await host.reportFatal(error);
  } finally {
    await host.close();
  }
}
