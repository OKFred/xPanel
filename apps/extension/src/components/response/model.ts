export const AUTO_PRETTY_LIMIT_BYTES = 1_048_576;
export const VIRTUALIZE_LIMIT_BYTES = 262_144;
export const VIRTUALIZE_LINE_LIMIT = 5_000;
export const MAX_DISPLAY_ROW_CHARS = 4_096;
export const MAX_RENDERED_ROWS = 200;

export type ResponseDocumentMode = "pretty" | "raw";

export interface PreparedResponseDocument {
  text: string;
  rows: string[];
  formatted: boolean;
  virtualized: boolean;
  maxRowCharacters: number;
}

export function shouldAutoPretty(sizeBytes: number): boolean {
  return sizeBytes <= AUTO_PRETTY_LIMIT_BYTES;
}

export function splitDisplayRows(
  text: string,
  maximumCharacters = MAX_DISPLAY_ROW_CHARS,
): string[] {
  if (!Number.isInteger(maximumCharacters) || maximumCharacters <= 0) {
    throw new RangeError("maximumCharacters must be a positive integer");
  }

  const rows: string[] = [];
  for (const logicalLine of text.split(/\r\n|\r|\n/u)) {
    if (logicalLine.length === 0) {
      rows.push("");
      continue;
    }
    for (
      let offset = 0;
      offset < logicalLine.length;
      offset += maximumCharacters
    ) {
      rows.push(logicalLine.slice(offset, offset + maximumCharacters));
    }
  }
  return rows.length > 0 ? rows : [""];
}

export function prepareResponseDocument(
  raw: string,
  mode: ResponseDocumentMode,
  sizeBytes: number,
): PreparedResponseDocument {
  let text = raw;
  let formatted = false;
  if (mode === "pretty" && raw !== "") {
    try {
      text = JSON.stringify(JSON.parse(raw) as unknown, null, 2);
      formatted = true;
    } catch {
      text = raw;
    }
  }

  const rows = splitDisplayRows(text);
  return {
    text,
    rows,
    formatted,
    virtualized:
      sizeBytes > VIRTUALIZE_LIMIT_BYTES || rows.length > VIRTUALIZE_LINE_LIMIT,
    maxRowCharacters: rows.reduce(
      (maximum, row) => Math.max(maximum, row.length),
      0,
    ),
  };
}

export function visibleRowRange(
  scrollTop: number,
  viewportHeight: number,
  rowCount: number,
  rowHeight: number,
  overscan = 20,
): { start: number; count: number } {
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const visible = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
  const count = Math.min(MAX_RENDERED_ROWS, Math.max(1, visible));
  return { start: Math.min(first, Math.max(0, rowCount - 1)), count };
}
