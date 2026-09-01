import { requestSpecV1Schema, type RequestSpecV1 } from "@xpanel/contracts";

export function requestFixture(
  overrides: Partial<RequestSpecV1> = {},
): RequestSpecV1 {
  return requestSpecV1Schema.parse({
    id: "request-1",
    name: "Fixture request",
    method: "GET",
    url: "https://example.test/path",
    query: [],
    headers: [],
    auth: { kind: "none" },
    body: { kind: "none" },
    options: {
      redirect: "manual",
      cookieMode: "omit",
      timeoutMs: 5_000,
      proxy: null,
      tls: { verify: true },
    },
    source: { format: "manual" },
    favorite: false,
    warnings: [],
    ...overrides,
  });
}
