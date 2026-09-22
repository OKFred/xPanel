import assert from "node:assert/strict";
import test from "node:test";
import { verifyTruncatedFixture } from "./cloudflare-target-config.mjs";

test("truncation probe requires a promised wire length and an actual read failure", async () => {
  await verifyTruncatedFixture(
    "https://synthetic.example",
    async (url, init) => {
      assert.equal(url, "https://synthetic.example/truncated-fixed");
      assert.equal(init.headers, undefined);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError("synthetic disconnect"));
          },
        }),
        { headers: { "Content-Length": "14" } },
      );
    },
  );
  await assert.rejects(
    verifyTruncatedFixture(
      "https://synthetic.example",
      async () =>
        new Response("partial", { headers: { "Content-Length": "14" } }),
    ),
    /completed instead/,
  );
  await assert.rejects(
    verifyTruncatedFixture(
      "https://synthetic.example",
      async () => new Response("partial"),
    ),
    /advertised length/,
  );
  await assert.rejects(
    verifyTruncatedFixture(
      "https://synthetic.example",
      async () => new Response(null, { status: 404 }),
    ),
    /advertised length/,
  );
});
