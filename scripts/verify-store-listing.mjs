import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "..");
const submissionPath = join(
  workspaceRoot,
  "docs",
  "chrome-web-store",
  "submission.md",
);
const submission = await readFile(submissionPath, "utf8");

function sectionBetween(start, end) {
  const startIndex = submission.indexOf(start);
  if (startIndex < 0)
    throw new Error(`Missing Store listing section: ${start}`);
  const contentStart = startIndex + start.length;
  const endIndex = submission.indexOf(end, contentStart);
  if (endIndex < 0) throw new Error(`Missing Store listing boundary: ${end}`);
  return submission.slice(contentStart, endIndex);
}

function detailedDescription(section, locale) {
  const marker = "### Detailed description";
  const markerIndex = section.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`${locale} Store listing has no detailed description.`);
  }
  return section.slice(markerIndex + marker.length).trim();
}

const descriptions = [
  {
    locale: "English",
    text: detailedDescription(
      sectionBetween("## English listing", "## Chinese (Simplified) listing"),
      "English",
    ),
    required:
      "Bring requests in from common developer-tool exports and API documents",
  },
  {
    locale: "Chinese (Simplified)",
    text: detailedDescription(
      sectionBetween("## Chinese (Simplified) listing", "## Privacy practices"),
      "Chinese (Simplified)",
    ),
    required: "从常见开发工具导出内容和接口文档中导入请求",
  },
];

const rejectedKeywordPatterns = [
  /cURL/iu,
  /PowerShell/iu,
  /Node(?:\.js)?\s+fetch/iu,
  /HAR(?:\s+1\.2)?/u,
  /OpenAPI(?:\s+3(?:\.x)?)?/iu,
  /Swagger(?:\s+2(?:\.0)?)?/iu,
  /版本化\s*xPanel/u,
];

for (const { locale, required, text } of descriptions) {
  if (!text.includes(required)) {
    throw new Error(`${locale} Store listing is not using the reviewed copy.`);
  }
  const matches = rejectedKeywordPatterns
    .filter((pattern) => pattern.test(text))
    .map((pattern) => pattern.source);
  if (matches.length > 0) {
    throw new Error(
      `${locale} detailed description reintroduced Yellow Argon format keywords: ${matches.join(", ")}.`,
    );
  }
}

process.stdout.write(
  "Chrome Web Store listing verified: localized descriptions use the reviewed Yellow Argon-safe copy.\n",
);
