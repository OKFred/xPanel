import type { ResponseDocumentMode } from "./model";
import type {
  ResponseDocumentWorkerRequest,
  ResponseDocumentWorkerResponse,
} from "./protocol";

export type PreparedDocumentMetadata = Extract<
  ResponseDocumentWorkerResponse,
  { type: "prepared" }
>;

type ResponseOf<T extends ResponseDocumentWorkerRequest["type"]> = Extract<
  ResponseDocumentWorkerResponse,
  {
    type: T extends "prepare"
      ? "prepared"
      : T extends "dispose"
        ? "disposed"
        : T;
  }
>;

function identifier(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

export class ResponseDocumentWorkerClient {
  readonly #worker: Worker;
  readonly #pending = new Map<
    string,
    {
      resolve: (response: ResponseDocumentWorkerResponse) => void;
      reject: (error: Error) => void;
    }
  >();

  constructor(worker?: Worker) {
    this.#worker =
      worker ??
      new Worker(chrome.runtime.getURL("response-document.js"), {
        type: "module",
      });
    this.#worker.addEventListener(
      "message",
      (event: MessageEvent<ResponseDocumentWorkerResponse>) => {
        const pending = this.#pending.get(event.data.operationId);
        if (!pending) return;
        this.#pending.delete(event.data.operationId);
        if (event.data.type === "error") {
          pending.reject(new Error(event.data.message));
        } else {
          pending.resolve(event.data);
        }
      },
    );
    this.#worker.addEventListener("error", (event) => {
      const error = new Error(event.message || "Response worker failed.");
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    });
  }

  async prepare(
    documentId: string,
    source: Blob,
    mode: ResponseDocumentMode,
    sizeBytes: number,
    encoding: "utf8" | "base64",
    sourceContainsEncodedText: boolean,
  ): Promise<PreparedDocumentMetadata> {
    return this.#request({
      type: "prepare",
      operationId: identifier(),
      documentId,
      source,
      mode,
      sizeBytes,
      encoding,
      sourceContainsEncodedText,
    });
  }

  async slice(
    documentId: string,
    start: number,
    count: number,
  ): Promise<ResponseOf<"slice">> {
    return this.#request({
      type: "slice",
      operationId: identifier(),
      documentId,
      start,
      count,
    });
  }

  async fullText(documentId: string): Promise<string> {
    const response = await this.#request({
      type: "full-text",
      operationId: identifier(),
      documentId,
    });
    return response.text;
  }

  async disposeDocument(documentId: string): Promise<void> {
    await this.#request({
      type: "dispose",
      operationId: identifier(),
      documentId,
    });
  }

  terminate(): void {
    this.#worker.terminate();
    for (const pending of this.#pending.values()) {
      pending.reject(new Error("Response worker was terminated."));
    }
    this.#pending.clear();
  }

  #request<T extends ResponseDocumentWorkerRequest>(
    request: T,
  ): Promise<ResponseOf<T["type"]>> {
    return new Promise((resolve, reject) => {
      this.#pending.set(request.operationId, {
        resolve: (response) => resolve(response as ResponseOf<T["type"]>),
        reject,
      });
      this.#worker.postMessage(request);
    });
  }
}
