import { createServer } from "node:http";

import { invariant } from "./utils.mjs";

const translationListFixture = JSON.stringify({
  marker: "large-json-e2e-ok",
  count: 1_914,
  data: Array.from({ length: 1_914 }, (_, index) => ({
    id: index + 1,
    locale: "zh-CN",
    namespace: "admin",
    key: `fixture.translation.${String(index + 1).padStart(4, "0")}`,
    value: `Synthetic ${index + 1} ${"x".repeat(48)}`,
    enabled: true,
  })),
});

function readBody(request, callback) {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => callback(Buffer.concat(chunks).toString("utf8")));
}

export function fixtureServer() {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const requestOrigin = request.headers.origin;
    const cors = {
      "Access-Control-Allow-Headers":
        request.headers["access-control-request-headers"] ?? "Content-Type",
      "Access-Control-Allow-Methods":
        "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Origin": requestOrigin ?? "*",
      "Cache-Control": "no-store",
    };
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors);
      response.end();
      return;
    }
    if (url.pathname === "/page") {
      response.writeHead(200, {
        ...cors,
        "Content-Type": "text/html; charset=utf-8",
      });
      response.end(
        "<!doctype html><title>xPanel HAR fixture</title><link rel=icon href=data:,><script>fetch('/captured?via=har').catch(() => {});</script><main>fixture</main>",
      );
      return;
    }
    if (url.pathname === "/captured") {
      response.writeHead(200, {
        ...cors,
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end('{"captured":"har-e2e-ok"}');
      return;
    }
    if (url.pathname === "/stream") {
      const chunks = ['{"source":"browser",', '"result":"browser-e2e-ok"}'];
      const size = chunks.reduce(
        (total, chunk) => total + Buffer.byteLength(chunk),
        0,
      );
      response.writeHead(200, {
        ...cors,
        "Content-Length": String(size),
        "Content-Type": "application/json; charset=utf-8",
      });
      response.write(chunks[0]);
      setTimeout(() => response.end(chunks[1]), 180);
      return;
    }
    if (url.pathname === "/large-json") {
      readBody(request, (body) => {
        if (request.method !== "POST" || body !== "{}") {
          response.writeHead(400, {
            ...cors,
            "Content-Type": "application/json; charset=utf-8",
          });
          response.end(
            JSON.stringify({ error: "Expected a POST request with body {}." }),
          );
          return;
        }
        response.writeHead(200, {
          ...cors,
          "Content-Length": String(Buffer.byteLength(translationListFixture)),
          "Content-Type": "application/json; charset=utf-8",
          "X-XPanel-Fixture-Items": "1914",
        });
        response.end(translationListFixture);
      });
      return;
    }
    if (url.pathname === "/slow-complete") {
      response.writeHead(200, {
        ...cors,
        "Content-Type": "application/json; charset=utf-8",
      });
      response.flushHeaders();
      response.write('{"marker":"background-e2e-ok","payload":"');
      let remaining = 96;
      const interval = globalThis.setInterval(() => {
        if (response.destroyed) {
          globalThis.clearInterval(interval);
          return;
        }
        response.write("x".repeat(8 * 1_024));
        remaining -= 1;
        if (remaining === 0) {
          globalThis.clearInterval(interval);
          response.end('"}');
        }
      }, 90);
      response.once("close", () => globalThis.clearInterval(interval));
      return;
    }
    if (url.pathname === "/slow") {
      response.writeHead(200, {
        ...cors,
        "Content-Type": "text/plain; charset=utf-8",
      });
      const timeout = setTimeout(() => response.end("too late"), 10_000);
      response.once("close", () => clearTimeout(timeout));
      return;
    }
    response.writeHead(404, {
      ...cors,
      "Content-Type": "text/plain; charset=utf-8",
    });
    response.end("not found");
  });
}

export async function listen(server) {
  await new Promise((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveReady);
  });
  const address = server.address();
  invariant(address && typeof address !== "string", "Fixture did not bind.");
  return address.port;
}
