/// <reference lib="webworker" />

import { prepareResponseDocument } from "./model";
import type {
  ResponseDocumentWorkerRequest,
  ResponseDocumentWorkerResponse,
} from "./protocol";

const documents = new Map<string, ReturnType<typeof prepareResponseDocument>>();

function post(message: ResponseDocumentWorkerResponse): void {
  self.postMessage(message);
}

self.addEventListener(
  "message",
  (event: MessageEvent<ResponseDocumentWorkerRequest>) => {
    void handle(event.data);
  },
);

async function handle(message: ResponseDocumentWorkerRequest): Promise<void> {
  try {
    if (message.type === "prepare") {
      const document = prepareResponseDocument(
        await message.source.text(),
        message.mode,
        message.sizeBytes,
      );
      documents.set(message.documentId, document);
      post({
        type: "prepared",
        operationId: message.operationId,
        documentId: message.documentId,
        rowCount: document.rows.length,
        formatted: document.formatted,
        virtualized: document.virtualized,
        maxRowCharacters: document.maxRowCharacters,
      });
      return;
    }

    const document = documents.get(message.documentId);
    if (!document) throw new Error("Response document is no longer available.");

    if (message.type === "slice") {
      const start = Math.max(0, Math.min(message.start, document.rows.length));
      const count = Math.max(0, message.count);
      post({
        type: "slice",
        operationId: message.operationId,
        documentId: message.documentId,
        start,
        rows: document.rows.slice(start, start + count),
      });
      return;
    }
    if (message.type === "full-text") {
      post({
        type: "full-text",
        operationId: message.operationId,
        documentId: message.documentId,
        text: document.text,
      });
      return;
    }
    documents.delete(message.documentId);
    post({
      type: "disposed",
      operationId: message.operationId,
      documentId: message.documentId,
    });
  } catch (error) {
    post({
      type: "error",
      operationId: message.operationId,
      documentId: message.documentId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export {};
