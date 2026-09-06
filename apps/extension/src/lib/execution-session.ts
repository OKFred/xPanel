const SESSION_ID_KEY = "executionSessionIdV1";

let cachedSessionId: string | undefined;

export async function executionSessionId(): Promise<string> {
  if (cachedSessionId) return cachedSessionId;
  const stored = await chrome.storage.session.get(SESSION_ID_KEY);
  const value: unknown = stored[SESSION_ID_KEY];
  if (typeof value === "string" && value.length > 0) {
    cachedSessionId = value;
    return value;
  }
  const sessionId = crypto.randomUUID();
  await chrome.storage.session.set({ [SESSION_ID_KEY]: sessionId });
  cachedSessionId = sessionId;
  return sessionId;
}
