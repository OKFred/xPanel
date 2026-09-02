import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const relayBaseUrl = requiredUrl("XPANEL_REMOTE_BASE_URL");
const targetBaseUrl = requiredUrl("XPANEL_REMOTE_TARGET_URL");
const relayToken = requiredValue("XPANEL_REMOTE_TOKEN");
const protocolVersion = "1";
const maxBodyBytes = 20 * 1024 * 1024;
let currentStage = "initialization";

function requiredValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

function requiredUrl(name) {
  const value = new URL(requiredValue(name));
  if (value.protocol !== "https:" || value.username || value.password) {
    throw new Error(`${name} must be a credential-free HTTPS URL.`);
  }
  value.search = "";
  value.hash = "";
  value.pathname = value.pathname.replace(/\/+$/u, "");
  return value;
}

function endpoint(baseUrl, path) {
  const basePath = baseUrl.pathname.replace(/\/+$/u, "");
  const childPath = path.replace(/^\/+/u, "");
  return new URL(`${basePath}/${childPath}`, `${baseUrl.origin}/`);
}

function encodeMetadata(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeMetadata(value) {
  assert.ok(value, "The Relay response metadata header is missing.");
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function relayHeaders(token = relayToken) {
  return {
    Authorization: `Bearer ${token}`,
    "X-XPanel-Protocol": protocolVersion,
  };
}

function isTransientNetworkError(error) {
  const code = error?.cause?.code;
  return (
    error instanceof TypeError &&
    error.message === "fetch failed" &&
    ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(code)
  );
}

async function fetchRelay(input, init = {}) {
  const attempts = init.signal === undefined ? 3 : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(input, init);
    } catch (error) {
      if (attempt === attempts || !isTransientNetworkError(error)) throw error;
      await new Promise((resolveWait) =>
        setTimeout(resolveWait, attempt * 250),
      );
    }
  }
  throw new Error("The Relay fetch retry loop ended unexpectedly.");
}

async function readError(response) {
  const envelope = await response.json();
  assert.equal(envelope.protocolVersion, 1);
  assert.equal(typeof envelope.error?.code, "string");
  return envelope;
}

async function executeRaw({
  url,
  method = "GET",
  headers = [],
  redirect = "follow",
  timeoutMs = 60_000,
  body = new Uint8Array(),
  bodySizeBytes = body.byteLength,
  signal,
}) {
  const requestId = randomUUID();
  const metadata = {
    protocolVersion: 1,
    requestId,
    method,
    url: url.toString(),
    headers,
    redirect,
    timeoutMs,
    bodySizeBytes,
  };
  const response = await fetchRelay(endpoint(relayBaseUrl, "/v1/execute"), {
    method: "POST",
    headers: {
      ...relayHeaders(),
      "Content-Type": "application/octet-stream",
      "X-XPanel-Request": encodeMetadata(metadata),
    },
    body,
    signal,
  });
  return { requestId, response };
}

async function execute(options) {
  const { requestId, response } = await executeRaw(options);
  if (!response.ok) {
    const envelope = await readError(response);
    throw new Error(
      `Relay error ${envelope.error.code}: ${envelope.error.message}`,
    );
  }
  const metadata = decodeMetadata(response.headers.get("X-XPanel-Response"));
  assert.equal(metadata.protocolVersion, 1);
  assert.equal(metadata.requestId, requestId);
  assert.ok(Array.isArray(metadata.headers));
  assert.ok(Array.isArray(metadata.redirects));
  return { metadata, response };
}

function headerValues(headers, name) {
  const normalized = name.toLowerCase();
  return headers
    .filter((header) => header.name.toLowerCase() === normalized)
    .map((header) => header.value);
}

async function expectRelayError(options, expectedStatus, expectedCode) {
  const { response } = await executeRaw(options);
  assert.equal(response.status, expectedStatus);
  const envelope = await readError(response);
  assert.equal(envelope.error.code, expectedCode);
}

async function run() {
  currentStage = "authentication";
  const unauthorized = await fetchRelay(
    endpoint(relayBaseUrl, "/v1/capabilities"),
    {
      headers: relayHeaders("intentionally-wrong-token"),
    },
  );
  assert.equal(unauthorized.status, 401);
  assert.equal((await readError(unauthorized)).error.code, "unauthorized");

  currentStage = "capabilities";
  const capabilitiesResponse = await fetchRelay(
    endpoint(relayBaseUrl, "/v1/capabilities"),
    { headers: relayHeaders() },
  );
  assert.equal(capabilitiesResponse.status, 200);
  const capabilities = await capabilitiesResponse.json();
  assert.deepEqual(
    {
      protocolVersion: capabilities.protocolVersion,
      provider: capabilities.provider,
      targetPolicy: capabilities.targetPolicy,
      maxMetadataBytes: capabilities.maxMetadataBytes,
      maxRequestBodyBytes: capabilities.maxRequestBodyBytes,
      maxResponseBodyBytes: capabilities.maxResponseBodyBytes,
    },
    {
      protocolVersion: 1,
      provider: "cloudflare",
      targetPolicy: "allowlist",
      maxMetadataBytes: 48 * 1024,
      maxRequestBodyBytes: maxBodyBytes,
      maxResponseBodyBytes: maxBodyBytes,
    },
  );

  currentStage = "headers and binary body";
  const binaryBody = Uint8Array.from([0, 1, 2, 127, 128, 255]);
  const echoed = await execute({
    url: endpoint(targetBaseUrl, "/echo"),
    method: "POST",
    headers: [
      { name: "Authorization", value: "Bearer synthetic-target-token" },
      { name: "Cookie", value: "fixture=synthetic" },
      { name: "DNT", value: "1" },
      { name: "Origin", value: "https://client.example" },
      { name: "Referer", value: "https://client.example/tool" },
      { name: "Sec-XPanel-Test", value: "allowed" },
      { name: "Content-Type", value: "application/octet-stream" },
    ],
    body: binaryBody,
  });
  assert.equal(echoed.metadata.status, 200);
  const echo = await echoed.response.json();
  assert.equal(echo.bodyBase64, Buffer.from(binaryBody).toString("base64"));
  for (const [name, value] of [
    ["authorization", "Bearer synthetic-target-token"],
    ["cookie", "fixture=synthetic"],
    ["dnt", "1"],
    ["origin", "https://client.example"],
    ["referer", "https://client.example/tool"],
    ["sec-xpanel-test", "allowed"],
  ]) {
    assert.equal(headerValues(echo.headers, name)[0], value);
  }
  assert.deepEqual(headerValues(echo.headers, "cache-control"), []);
  assert.deepEqual(headerValues(echo.headers, "pragma"), []);

  currentStage = "cache bypass without injected headers";
  const cacheProbeUrl = endpoint(
    targetBaseUrl,
    `/cache-probe?run=${randomUUID()}`,
  );
  const firstCacheProbe = await execute({ url: cacheProbeUrl });
  const secondCacheProbe = await execute({ url: cacheProbeUrl });
  const firstNonce = (await firstCacheProbe.response.json()).nonce;
  const secondNonce = (await secondCacheProbe.response.json()).nonce;
  assert.equal(typeof firstNonce, "string");
  assert.equal(typeof secondNonce, "string");
  assert.notEqual(firstNonce, secondNonce);

  currentStage = "multipart";
  const multipartBoundary = "xpanel-online-boundary";
  const multipartBody = Buffer.concat([
    Buffer.from(
      `--${multipartBoundary}\r\nContent-Disposition: form-data; name="note"\r\nX-Part-Test: preserved\r\n\r\nhello\r\n`,
    ),
    Buffer.from(
      `--${multipartBoundary}\r\nContent-Disposition: form-data; name="upload"; filename="synthetic.bin"\r\nContent-Type: application/octet-stream\r\nX-Part-File: preserved\r\n\r\n`,
    ),
    Buffer.from([0, 255, 1, 254]),
    Buffer.from(`\r\n--${multipartBoundary}--\r\n`),
  ]);
  const multipart = await execute({
    url: endpoint(targetBaseUrl, "/echo"),
    method: "POST",
    headers: [
      {
        name: "Content-Type",
        value: `multipart/form-data; boundary=${multipartBoundary}`,
      },
    ],
    body: multipartBody,
  });
  const multipartEcho = await multipart.response.json();
  assert.equal(multipartEcho.bodyBase64, multipartBody.toString("base64"));
  assert.match(
    headerValues(multipartEcho.headers, "content-type")[0],
    new RegExp(`boundary=${multipartBoundary}$`, "u"),
  );

  currentStage = "multiple Set-Cookie fields";
  const cookies = await execute({ url: endpoint(targetBaseUrl, "/cookies") });
  assert.deepEqual(headerValues(cookies.metadata.headers, "set-cookie"), [
    "alpha=one; Path=/; HttpOnly; Secure",
    "beta=two; Path=/; SameSite=Strict; Secure",
  ]);

  currentStage = "redirect modes";
  const manual = await execute({
    url: endpoint(targetBaseUrl, "/redirect"),
    redirect: "manual",
  });
  assert.equal(manual.metadata.status, 302);
  const followed = await execute({
    url: endpoint(targetBaseUrl, "/redirect"),
    redirect: "follow",
  });
  assert.equal(followed.metadata.status, 200);
  assert.equal(followed.metadata.redirects.length, 1);
  assert.deepEqual(await followed.response.json(), {
    result: "remote-e2e-ok",
  });
  await expectRelayError(
    {
      url: endpoint(targetBaseUrl, "/redirect"),
      redirect: "error",
    },
    400,
    "redirect_disallowed",
  );

  currentStage = "SSRF and redirect target revalidation";
  await expectRelayError(
    { url: new URL("https://127.0.0.1/private") },
    403,
    "target_not_allowed",
  );
  await expectRelayError(
    { url: endpoint(targetBaseUrl, "/redirect-cross-origin") },
    403,
    "target_not_allowed",
  );

  currentStage = "streaming response";
  const streamStarted = performance.now();
  const streamed = await execute({ url: endpoint(targetBaseUrl, "/stream") });
  const reader = streamed.response.body.getReader();
  const first = await reader.read();
  const firstChunkMs = performance.now() - streamStarted;
  assert.equal(first.done, false);
  const chunks = [first.value];
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
  }
  const streamDurationMs = performance.now() - streamStarted;
  assert.ok(
    chunks.length >= 2,
    "The Relay response was buffered instead of streamed.",
  );
  assert.ok(
    firstChunkMs + 600 < streamDurationMs,
    "The first streamed bytes did not arrive before completion.",
  );

  currentStage = "20 MiB request";
  const exactRequest = new Uint8Array(maxBodyBytes).fill(0x61);
  const sink = await execute({
    url: endpoint(targetBaseUrl, "/sink"),
    method: "POST",
    headers: [{ name: "Content-Type", value: "application/octet-stream" }],
    body: exactRequest,
  });
  assert.equal((await sink.response.json()).sizeBytes, maxBodyBytes);

  currentStage = "20 MiB + 1 request";
  await expectRelayError(
    {
      url: endpoint(targetBaseUrl, "/sink"),
      method: "POST",
      bodySizeBytes: maxBodyBytes + 1,
    },
    413,
    "payload_too_large",
  );
  await expectRelayError(
    {
      url: endpoint(targetBaseUrl, "/sink"),
      method: "POST",
      headers: [{ name: "Content-Type", value: "application/octet-stream" }],
      body: new Uint8Array(maxBodyBytes + 1),
      bodySizeBytes: maxBodyBytes,
    },
    413,
    "payload_too_large",
  );

  currentStage = "20 MiB response";
  const exactResponse = await execute({
    url: endpoint(targetBaseUrl, `/large?bytes=${maxBodyBytes}`),
  });
  assert.equal(
    (await exactResponse.response.arrayBuffer()).byteLength,
    maxBodyBytes,
  );
  currentStage = "oversized declared response";
  await expectRelayError(
    { url: endpoint(targetBaseUrl, `/large?bytes=${maxBodyBytes + 1}`) },
    502,
    "response_too_large",
  );

  currentStage = "timeout";
  await expectRelayError(
    {
      url: endpoint(targetBaseUrl, "/slow?ms=750"),
      timeoutMs: 100,
    },
    504,
    "timeout",
  );

  currentStage = "client cancellation";
  const controller = new AbortController();
  const cancelled = executeRaw({
    url: endpoint(targetBaseUrl, "/slow?ms=3000"),
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(cancelled, (error) => error?.name === "AbortError");

  process.stdout.write(
    "Online Relay acceptance passed: auth, headers, cache bypass, binary, multipart, cookies, redirects, streaming, 20 MiB limits, timeout, cancellation.\n",
  );
}

try {
  await run();
} catch (error) {
  throw new Error(`Online Relay acceptance failed during ${currentStage}.`, {
    cause: error,
  });
}
