import { createServer } from "node:http";

import { invariant } from "./utils.mjs";

export function fixtureServer() {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const requestOrigin = request.headers.origin;
    const cors = {
      "Access-Control-Allow-Headers": "*",
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
