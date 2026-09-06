export function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export async function waitFor(probe, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(
    `${description} did not become ready.${lastError ? ` ${lastError}` : ""}`,
  );
}
