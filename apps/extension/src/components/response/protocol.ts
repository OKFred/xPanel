import type { ResponseDocumentMode } from "./model";

export type ResponseDocumentWorkerRequest =
  | {
      type: "prepare";
      operationId: string;
      documentId: string;
      source: Blob;
      mode: ResponseDocumentMode;
      sizeBytes: number;
      encoding: "utf8" | "base64";
      sourceContainsEncodedText: boolean;
    }
  | {
      type: "slice";
      operationId: string;
      documentId: string;
      start: number;
      count: number;
    }
  | {
      type: "full-text";
      operationId: string;
      documentId: string;
    }
  | {
      type: "dispose";
      operationId: string;
      documentId: string;
    };

export type ResponseDocumentWorkerResponse =
  | {
      type: "prepared";
      operationId: string;
      documentId: string;
      rowCount: number;
      formatted: boolean;
      virtualized: boolean;
      maxRowCharacters: number;
    }
  | {
      type: "slice";
      operationId: string;
      documentId: string;
      start: number;
      rows: string[];
    }
  | {
      type: "full-text";
      operationId: string;
      documentId: string;
      text: string;
    }
  | {
      type: "disposed";
      operationId: string;
      documentId: string;
    }
  | {
      type: "error";
      operationId: string;
      documentId: string;
      message: string;
    };
