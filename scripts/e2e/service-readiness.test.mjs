import assert from "node:assert/strict";
import test from "node:test";
import {
  waitForControlRoutes,
  waitForGatewayRoute,
} from "./service-readiness.mjs";

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
  assert.equal(calls, 10);
  assert.equal(waits, 4);
});

test("Control readiness resets after an intermittent provider response", async () => {
  let calls = 0;
  const rounds = [200, 200, 503, 200, 200, 200];
  await waitForControlRoutes("https://control.example", {
    fetch: async () =>
      new Response(null, { status: rounds[Math.floor(calls++ / 2)] }),
    wait: async () => {},
  });
  assert.equal(calls, 12);
});

test("Gateway readiness requires protocol response, sends no credentials or target", async () => {
  let calls = 0;
  await waitForGatewayRoute("https://gateway.example/", {
    fetch: async (url, init) => {
      assert.equal(url, "https://gateway.example/");
      assert.equal(init.method, "GET");
      assert.equal(init.headers, undefined);
      calls += 1;
      return new Response(
        null,
        calls < 3
          ? { status: 404 }
          : {
              status: 400,
              headers: { "One-Fetch-Response": "application-rejection" },
            },
      );
    },
    wait: async () => {},
  });
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(
    waitForGatewayRoute("https://gateway.example/", {
      fetch: async () => {
        calls += 1;
        return new Response(null, { status: 400 });
      },
      wait: async () => {},
    }),
    /bounded startup/,
  );
  assert.equal(calls, 10);
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
