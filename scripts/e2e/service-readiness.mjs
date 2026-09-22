import { invariant } from "./utils.mjs";

/** Retry read-only startup probes, never install/bootstrap/deployment actions. */
export async function waitForControlRoutes(controlUrl, dependencies = {}) {
  const read = dependencies.fetch ?? fetch;
  const wait =
    dependencies.wait ??
    (() => new Promise((resolveWait) => setTimeout(resolveWait, 5_000)));
  let ready = false;
  let consecutive = 0;
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
      consecutive = ready ? consecutive + 1 : 0;
      // New workers.dev routes can briefly alternate between application and
      // provider responses. Require stable reads before acquiring verify's lock.
      if (consecutive >= 3) return;
      // Authorization/configuration errors are not propagation delays.
      invariant(
        !responses.some((response) =>
          [400, 401, 403].includes(response.status),
        ),
        "Control readiness rejected the unauthenticated public routes.",
      );
    } catch (error) {
      consecutive = 0;
      if (!(error instanceof TypeError) || attempt === 9) throw error;
    }
    if (attempt < 9) await wait();
  }
  invariant(
    consecutive >= 3,
    "Control public routes did not become ready within the bounded startup window.",
  );
}

/** No token or target metadata: this probe cannot initiate an upstream request. */
export async function waitForGatewayRoute(gatewayUrl, dependencies = {}) {
  const read = dependencies.fetch ?? fetch;
  const wait =
    dependencies.wait ?? (() => new Promise((done) => setTimeout(done, 5_000)));
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const response = await read(gatewayUrl, {
        method: "GET",
        cache: "no-store",
        redirect: "error",
        signal: globalThis.AbortSignal.timeout(10_000),
      });
      // This checks application routing, not credential or signature validity.
      const ready =
        response.status === 400 && response.headers.has("One-Fetch-Response");
      await response.body?.cancel();
      if (ready) return;
    } catch (error) {
      if (!(error instanceof TypeError) || attempt === 9) throw error;
    }
    if (attempt < 9) await wait();
  }
  throw new Error(
    "Gateway did not return its protocol rejection within the bounded startup window.",
  );
}
