import assert from "node:assert/strict";
import test from "node:test";
import { waitForControlRoutes } from "./service-readiness.mjs";

test("waits only on read-only public routes and retries propagation", async () => {
  let calls = 0;
  let waits = 0;
  await waitForControlRoutes("https://control.example/", {
    fetch: async (url, init) => {
      assert.match(url, /\/api\/v1\/(health|capabilities)$/u);
      assert.equal(init.method, "GET");
      assert.equal(init.headers, undefined);
      return new Response(null, { status: calls++ < 4 ? 404 : 200 });
    },
    wait: async () => {
      waits += 1;
    },
  });
  assert.equal(calls, 6);
  assert.equal(waits, 2);
});

test("fails closed on authorization and bounded never-ready probes", async () => {
  let calls = 0;
  await assert.rejects(
    waitForControlRoutes("https://control.example", {
      fetch: async () => {
        calls += 1;
        return new Response(null, { status: 403 });
      },
    }),
    /rejected/,
  );
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(
    waitForControlRoutes("https://control.example", {
      fetch: async () => {
        calls += 1;
        return new Response(null, { status: 404 });
      },
      wait: async () => {},
    }),
    /bounded startup/,
  );
  assert.equal(calls, 20);
});
