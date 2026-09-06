import { describe, expect, it } from "vitest";

import {
  AUTO_PRETTY_LIMIT_BYTES,
  MAX_DISPLAY_ROW_CHARS,
  MAX_RENDERED_ROWS,
  prepareResponseDocument,
  shouldAutoPretty,
  splitDisplayRows,
  visibleRowRange,
} from "../src/components/response/model";

describe("response document model", () => {
  it("formats valid JSON without changing invalid text", () => {
    const formatted = prepareResponseDocument('{"ok":true}', "pretty", 11);
    expect(formatted.formatted).toBe(true);
    expect(formatted.text).toContain('\n  "ok": true\n');

    const plain = prepareResponseDocument("not-json", "pretty", 8);
    expect(plain.formatted).toBe(false);
    expect(plain.text).toBe("not-json");
  });

  it("defers automatic pretty printing above one MiB", () => {
    expect(shouldAutoPretty(AUTO_PRETTY_LIMIT_BYTES)).toBe(true);
    expect(shouldAutoPretty(AUTO_PRETTY_LIMIT_BYTES + 1)).toBe(false);
  });

  it("segments pathological single lines", () => {
    const text = "x".repeat(MAX_DISPLAY_ROW_CHARS * 2 + 7);
    const rows = splitDisplayRows(text);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.length)).toEqual([
      MAX_DISPLAY_ROW_CHARS,
      MAX_DISPLAY_ROW_CHARS,
      7,
    ]);
  });

  it("never asks the DOM to render more than 200 rows", () => {
    const range = visibleRowRange(300_000, 100_000, 50_000, 17, 50);
    expect(range.count).toBe(MAX_RENDERED_ROWS);
    expect(range.start).toBeGreaterThan(0);
  });

  it("virtualizes the measured listAll-sized response shape", () => {
    const raw = JSON.stringify({
      data: Array.from({ length: 1_914 }, (_, index) => ({
        id: index,
        key: `translation.${index}`,
        value: `value-${index}`,
      })),
    });
    const document = prepareResponseDocument(raw, "pretty", 318_193);
    expect(document.virtualized).toBe(true);
    expect(document.rows.length).toBeGreaterThan(5_000);
  });
});
