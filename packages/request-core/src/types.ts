import type {
  CollectionRecord,
  ImportWarning,
  RequestSpecV1,
  ResponseRecordV1,
} from "@xpanel/contracts";

export type ImportFormat =
  | "curl-bash"
  | "powershell"
  | "fetch-node"
  | "har"
  | "openapi"
  | "swagger"
  | "xpanel-collection"
  | "json"
  | "unknown";

export type ExportFormat = Exclude<ImportFormat, "json" | "unknown">;

export interface ImportResult {
  format: ImportFormat;
  requests: RequestSpecV1[];
  responses: ResponseRecordV1[];
  collections: CollectionRecord[];
  warnings: ImportWarning[];
}

export interface ImportOptions {
  fileName?: string;
  baseUrl?: string;
  collectionName?: string;
  /**
   * The caller owns network and permission policy. The core never fetches a
   * remote reference by itself.
   */
  resolveExternalRef?: (absoluteUrl: string) => Promise<string | object>;
  maxRefDepth?: number;
}

export interface ExportOptions {
  includeSensitive?: boolean;
  pretty?: boolean;
  responses?: ResponseRecordV1[];
  title?: string;
}

export interface TextExport {
  mediaType: string;
  extension: string;
  text: string;
  warnings: ImportWarning[];
}

export interface OpenApiDocumentExport {
  format: "openapi";
  documents: Record<string, Record<string, unknown>>;
  warnings: ImportWarning[];
}

export interface MergeCollectionsResult {
  collections: CollectionRecord[];
  requests: RequestSpecV1[];
  idMap: Record<string, string>;
}
