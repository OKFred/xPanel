import { invariant } from "./utils.mjs";

/** Retry read-only startup probes, never install/bootstrap/deployment actions. */
export async function waitForControlRoutes(controlUrl, dependencies = {}) {
  const read = dependencies.fetch ?? fetch;
  const wait =
    dependencies.wait ??
    (() => new Promise((resolveWait) => setTimeout(resolveWait, 5_000)));
  let ready = false;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const responses = await Promise.all(
        ["health", "capabilities"].map((route) =>
          read(`${controlUrl.replace(/\/+$/u, "")}/api/v1/${route}`, {
            method: "GET",
            cache: "no-store",
            redirect: "error",
            signal: globalThis.AbortSignal.timeout(10_000),
          }),
        ),
      );
      ready = responses.every((response) => response.ok);
      await Promise.all(responses.map((response) => response.body?.cancel()));
      if (ready) return;
      // Authorization/configuration errors are not propagation delays.
      invariant(
        !responses.some((response) =>
          [400, 401, 403].includes(response.status),
        ),
        "Control readiness rejected the unauthenticated public routes.",
      );
    } catch (error) {
      if (!(error instanceof TypeError) || attempt === 9) throw error;
    }
    if (attempt < 9) await wait();
  }
  invariant(
    ready,
    "Control public routes did not become ready within the bounded startup window.",
  );
}
