import type { RequestSpecV1 } from "@xpanel/contracts";

export interface BrowserHeaderIssue {
  kind: "name" | "value";
  location: string;
}

// HTTP field names are ASCII tokens. Names are not silently trimmed or repaired.
const token = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

function issueFor(
  name: string,
  value: string,
  location: string,
): BrowserHeaderIssue | undefined {
  if (!token.test(name)) return { kind: "name", location };
  // Fetch Headers accepts ByteString values, but rejects NUL/CR/LF.
  if (
    [...value].some((char) => {
      const code = char.charCodeAt(0);
      return code === 0 || code === 10 || code === 13 || code > 255;
    })
  )
    return { kind: "value", location };
  return undefined;
}

export function firstBrowserHeaderIssue(
  request: RequestSpecV1,
  ignoreHeader?: (name: string, value: string) => boolean,
): BrowserHeaderIssue | undefined {
  for (const [index, header] of request.headers.entries()) {
    if (!header.enabled || (header.name === "" && header.value === ""))
      continue;
    if (ignoreHeader?.(header.name, header.value)) continue;
    const issue = issueFor(header.name, header.value, `Headers[${index + 1}]`);
    if (issue) return issue;
  }
  const auth = request.auth;
  if (auth.kind === "api-key" && auth.location === "header") {
    return issueFor(auth.name, auth.value, "Auth");
  }
  if (auth.kind === "bearer")
    return issueFor("Authorization", `Bearer ${auth.token}`, "Auth");
  if (auth.kind === "oauth2")
    return issueFor(
      "Authorization",
      `${auth.tokenType} ${auth.accessToken}`,
      "Auth",
    );
  return undefined;
}

export function assertBrowserHeaderSyntax(request: RequestSpecV1): void {
  const issue = firstBrowserHeaderIssue(request);
  if (!issue) return;
  throw new Error(
    issue.kind === "name"
      ? `${issue.location}: invalid HTTP header name. Use an ASCII token without spaces, colons or line breaks.`
      : `${issue.location}: invalid Browser header value. Remove NUL/line breaks and characters outside the HTTP ByteString range.`,
  );
}
