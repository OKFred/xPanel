import { describe, expect, it } from "vitest";

import { exportHar, importHar } from "../src/har.js";

function readContent(content: Record<string, unknown>) {
  return importHar({
    log: {
      version: "1.2",
      entries: [
        {
          request: { method: "GET", url: "https://example.invalid/har" },
          response: { status: 200, content },
        },
      ],
    },
  });
}

describe("HAR captured response bytes", () => {
  it.each([{ size: 318_000 }, { size: 318_000, text: "" }, { size: -1 }, {}])(
    "stores zero captured bytes when the body is omitted: %j",
    (content) => {
      const result = readContent(content);
      expect(result.responses[0]?.body).toMatchObject({
        content: "",
        sizeBytes: 0,
      });
      expect(result.responses[0]?.warnings).toContainEqual(
        expect.objectContaining({ code: "har.response_body_missing" }),
      );
      expect(result.warnings).toContainEqual(
        expect.objectContaining({ code: "har.response_body_missing" }),
      );
    },
  );

  it.each([undefined, -1, 0, 1, 100])(
    "counts UTF-8 bytes instead of declared size %s",
    (size) => {
      const text = "中文🙂";
      const result = readContent({ text, size });
      expect(result.responses[0]?.body.sizeBytes).toBe(10);
      expect(result.responses[0]?.body.content).toBe(text);
      if (size !== undefined && size >= 0) {
        expect(result.warnings).toContainEqual(
          expect.objectContaining({ code: "har.response_size_mismatch" }),
        );
      }
    },
  );

  it.each([undefined, -1, 500])(
    "counts decoded binary bytes, not base64 characters: %s",
    (size) => {
      const result = readContent({
        text: "AP8BAg==",
        encoding: "base64",
        mimeType: "application/octet-stream",
        size,
      });
      expect(result.responses[0]?.body).toMatchObject({
        encoding: "base64",
        content: "AP8BAg==",
        sizeBytes: 4,
      });
      const roundTrip = importHar(
        exportHar(result.requests, result.responses, {
          includeSensitive: true,
        }),
      );
      expect(roundTrip.responses[0]?.body).toEqual(result.responses[0]?.body);
    },
  );

  it("preserves valid empty and matching bodies without warnings", () => {
    expect(readContent({ size: 0, text: "" }).warnings).toEqual([]);
    expect(readContent({ size: 3, text: "abc" }).warnings).toEqual([]);
    expect(
      readContent({ size: 4, text: "AP8BAg==", encoding: "base64" }).warnings,
    ).toEqual([]);
  });

  it.each([
    {
      text: "!not-base64!",
      encoding: "base64",
      code: "har.response_base64_invalid",
    },
    {
      text: "encoded",
      encoding: "unsupported",
      code: "har.response_encoding_unsupported",
    },
  ])(
    "keeps request and response metadata when content cannot be decoded: $code",
    ({ text, encoding, code }) => {
      const result = readContent({ text, encoding, size: 30 });
      expect(result.requests).toHaveLength(1);
      expect(result.responses[0]?.status).toBe(200);
      expect(result.responses[0]?.body).toMatchObject({
        content: "",
        sizeBytes: 0,
      });
      expect(result.warnings).toContainEqual(expect.objectContaining({ code }));
      expect(JSON.stringify(result.warnings)).not.toContain(text);
    },
  );
});
