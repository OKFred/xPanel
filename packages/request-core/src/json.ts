export function prettyJson(value: unknown, space = 2): string {
  const parsed: unknown =
    typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  return JSON.stringify(parsed, null, space);
}

export function compactJson(value: unknown): string {
  const parsed: unknown =
    typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  return JSON.stringify(parsed);
}
