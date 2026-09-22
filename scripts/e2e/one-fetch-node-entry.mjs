// Synthetic target plus the published Node adapter. Runs only in an owned,
// loopback-published, disposable Docker container; secrets remain in tmpfs.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { setInterval, clearInterval } from "node:timers";

await mkdir("/tmp/release");
execFileSync("tar", [
  "--no-same-owner",
  "-xzf",
  "/tmp/one-fetch.tar.gz",
  "-C",
  "/tmp/release",
]);
const key = generateKeyPairSync("ed25519");
Object.assign(process.env, {
  ONE_FETCH_AUDIT_SIGNING_PRIVATE_KEY: key.privateKey
    .export({ format: "der", type: "pkcs8" })
    .toString("base64"),
  ONE_FETCH_INSTANCE_PEPPER: randomBytes(32).toString("base64url"),
  ONE_FETCH_PROTOCOL_SIGNING_KEY: randomBytes(32).toString("base64url"),
  ONE_FETCH_DATABASE_PATH: "/tmp/state/one-fetch.sqlite",
  ONE_FETCH_CONTROL_HOST: "0.0.0.0",
  ONE_FETCH_GATEWAY_HOST: "0.0.0.0",
});
await mkdir("/tmp/state", { mode: 0o700 });
const target = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1:9090");
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const data = Buffer.concat(chunks);
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Set-Cookie", [
    "first=synthetic; HttpOnly",
    "second=synthetic; Secure",
  ]);
  response.setHeader("Server-Timing", "fixture;dur=2.5");
  if (url.pathname === "/slow") {
    response.flushHeaders();
    response.write('{"marker":"remote-slow","padding":"');
    const interval = setInterval(() => response.write("x".repeat(4096)), 100);
    const timeout = setTimeout(() => {
      clearInterval(interval);
      response.end('"}');
    }, 12_000);
    response.on("close", () => {
      clearInterval(interval);
      clearTimeout(timeout);
    });
    return;
  }
  if (url.pathname === "/partial") {
    response.setHeader("Content-Length", "1024");
    response.write('{"partial":true}');
    setTimeout(() => response.destroy(), 100);
    return;
  }
  if (url.pathname === "/bytes") {
    const size = Number(url.searchParams.get("size"));
    if (!Number.isInteger(size) || size < 0 || size > 20 * 1024 * 1024 + 1) {
      response.writeHead(400);
      response.end();
      return;
    }
    response.setHeader("Content-Type", "application/octet-stream");
    // No Content-Length: exercise byte counting rather than trusting metadata.
    response.write(Buffer.alloc(size, 65));
    response.end();
    return;
  }
  if (url.pathname.startsWith("/status/"))
    response.statusCode = Number(url.pathname.slice(8));
  response.end(
    JSON.stringify({
      marker: "remote-e2e-ok",
      method: request.method,
      path: request.url,
      bytes: data.byteLength,
      body: data.byteLength < 4096 ? data.toString("utf8") : "omitted",
      explicitCookie: request.headers.cookie ?? "",
      authorization: request.headers.authorization ?? "",
    }),
  );
});
await new Promise((resolve) => target.listen(9090, "127.0.0.1", resolve));
const { startOneFetchNode } = await import(
  "/tmp/release/one-fetch/dist/server.js"
);
const server = await startOneFetchNode();
await writeFile("/tmp/state/bootstrap", server.bootstrapToken, {
  mode: 0o600,
  flag: "wx",
});
server.fatal.then(() => {
  process.exitCode = 1;
  target.close();
});
process.on("SIGTERM", () => {
  void server.close().finally(() => target.close());
});
