import type {
  CollectionRecord,
  ImportWarning,
  RequestSpecV1,
} from "@xpanel/contracts";

import {
  exportCollectionFileWithWarnings,
  parseCollectionFile,
} from "./collection.js";
import { safeId, warning } from "./common.js";
import { exportCurlBash, parseCurlBash } from "./curl.js";
import { detectImportFormat } from "./detect.js";
import { exportNodeFetch, parseNodeFetch } from "./fetch.js";
import { exportHarWithWarnings, importHar } from "./har.js";
import { exportOpenApi, exportSwagger, importOpenApi } from "./openapi.js";
import { exportPowerShell, parsePowerShell } from "./powershell.js";
import type {
  ExportFormat,
  ExportOptions,
  ImportOptions,
  ImportResult,
  OpenApiDocumentExport,
  TextExport,
} from "./types.js";

export async function parseImport(
  input: string,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const format = detectImportFormat(input, options.fileName);
  switch (format) {
    case "curl-bash": {
      const result = parseCurlBash(input);
      return emptyImport(format, result.requests, result.warnings);
    }
    case "powershell": {
      const result = parsePowerShell(input);
      return emptyImport(format, result.requests, result.warnings);
    }
    case "fetch-node": {
      const result = parseNodeFetch(input);
      return emptyImport(format, result.requests, result.warnings);
    }
    case "har": {
      const result = importHar(input);
      return {
        format,
        requests: result.requests,
        responses: result.responses,
        collections: [],
        warnings: result.warnings,
      };
    }
    case "openapi":
    case "swagger": {
      const result = await importOpenApi(input, options);
      return emptyImport(result.format, result.requests, result.warnings);
    }
    case "xpanel-collection": {
      const result = parseCollectionFile(input);
      return {
        format,
        requests: result.file?.requests ?? [],
        responses: [],
        collections: result.file?.collections ?? [],
        warnings: result.warnings,
      };
    }
    case "json":
    case "unknown":
      return emptyImport(
        format,
        [],
        [
          warning(
            "import.format_unsupported",
            format === "json"
              ? "The JSON is valid but is not HAR, OpenAPI, Swagger, or an xPanel collection."
              : "The input format could not be detected.",
          ),
        ],
      );
  }
}

export function exportRequest(
  request: RequestSpecV1,
  format: ExportFormat,
  options: ExportOptions = {},
): TextExport | OpenApiDocumentExport {
  switch (format) {
    case "curl-bash": {
      const result = exportCurlBash(request, options);
      return textExport(
        "text/x-shellscript",
        "sh",
        result.text,
        result.warnings,
      );
    }
    case "powershell": {
      const result = exportPowerShell(request, options);
      return textExport("text/plain", "ps1", result.text, result.warnings);
    }
    case "fetch-node": {
      const result = exportNodeFetch(request, options);
      return textExport("text/javascript", "mjs", result.text, result.warnings);
    }
    case "har": {
      const result = exportHarWithWarnings(
        [request],
        options.responses ?? [],
        options,
      );
      return textExport(
        "application/json",
        "har",
        JSON.stringify(result.value, null, options.pretty === false ? 0 : 2),
        result.warnings,
      );
    }
    case "openapi":
      return exportOpenApi([request], options);
    case "swagger":
      return exportSwagger([request], options);
    case "xpanel-collection": {
      const now = new Date().toISOString();
      const collection: CollectionRecord = {
        id: safeId("collection"),
        name: (options.title ?? request.name) || "Imported request",
        description: "",
        requestIds: [request.id],
        createdAt: now,
        updatedAt: now,
      };
      const result = exportCollectionFileWithWarnings(
        [collection],
        [request],
        options,
      );
      return textExport(
        "application/json",
        "xpanel.collection.v1.json",
        JSON.stringify(result.value, null, options.pretty === false ? 0 : 2),
        result.warnings,
      );
    }
  }
}

function emptyImport(
  format: ImportResult["format"],
  requests: RequestSpecV1[],
  warnings: ImportWarning[],
): ImportResult {
  return { format, requests, responses: [], collections: [], warnings };
}

function textExport(
  mediaType: string,
  extension: string,
  text: string,
  warnings: ImportWarning[],
): TextExport {
  return { mediaType, extension, text, warnings };
}
