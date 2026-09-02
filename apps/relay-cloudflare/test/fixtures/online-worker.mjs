const encoder = new TextEncoder();

function json(value, init = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { ...init, headers });
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

function delayedStream(first, second, delayMs) {
  let timer;
  const firstBytes = typeof first === "string" ? encoder.encode(first) : first;
  const secondBytes =
    typeof second === "string" ? encoder.encode(second) : second;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(firstBytes);
      timer = setTimeout(() => {
        controller.enqueue(secondBytes);
        controller.close();
      }, delayMs);
    },
    cancel() {
      clearTimeout(timer);
    },
  });
}

function waitFor(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Fixture request cancelled", "AbortError"));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/echo") {
      const body = new Uint8Array(await request.arrayBuffer());
      return json({
        method: request.method,
        url: request.url,
        headers: [...request.headers].map(([name, value]) => ({ name, value })),
        bodyBase64: bytesToBase64(body),
      });
    }

    if (url.pathname === "/sink") {
      const body = new Uint8Array(await request.arrayBuffer());
      return json({ sizeBytes: body.byteLength });
    }

    if (url.pathname === "/cookies") {
      const headers = new Headers({
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
      });
      headers.append("Set-Cookie", "alpha=one; Path=/; HttpOnly; Secure");
      headers.append("Set-Cookie", "beta=two; Path=/; SameSite=Strict; Secure");
      return new Response("cookies", { headers });
    }

    if (url.pathname === "/cache-probe") {
      return json(
        { nonce: crypto.randomUUID() },
        { headers: { "Cache-Control": "public, max-age=3600" } },
      );
    }

    if (url.pathname === "/redirect") {
      return new Response(null, {
        status: 302,
        headers: { Location: "/e2e" },
      });
    }

    if (url.pathname === "/redirect-cross-origin") {
      return new Response(null, {
        status: 307,
        headers: { Location: "https://example.com/synthetic-target" },
      });
    }

    if (url.pathname === "/e2e") {
      const body = '{"result":"remote-e2e-ok"}';
      return new Response(
        delayedStream(body.slice(0, 12), body.slice(12), 500),
        {
          headers: {
            "Cache-Control": "no-store",
            "Content-Length": String(encoder.encode(body).byteLength),
            "Content-Type": "application/json; charset=utf-8",
          },
        },
      );
    }

    if (url.pathname === "/large") {
      const requestedSize = Number(url.searchParams.get("bytes"));
      const size = Number.isSafeInteger(requestedSize)
        ? Math.max(0, Math.min(requestedSize, 21 * 1024 * 1024))
        : 0;
      return new Response(new Uint8Array(size).fill(0x78), {
        headers: {
          "Cache-Control": "no-store",
          "Content-Length": String(size),
          "Content-Type": "application/octet-stream",
        },
      });
    }

    if (url.pathname === "/stream") {
      const first = new Uint8Array(256 * 1024).fill(0x61);
      const second = new Uint8Array(256 * 1024).fill(0x62);
      return new Response(delayedStream(first, second, 1_200), {
        headers: {
          "Cache-Control": "no-store",
          "Content-Length": String(first.byteLength + second.byteLength),
          "Content-Type": "application/octet-stream",
        },
      });
    }

    if (url.pathname === "/slow") {
      const requestedDelay = Number(url.searchParams.get("ms"));
      const delayMs = Number.isFinite(requestedDelay)
        ? Math.max(0, Math.min(requestedDelay, 5_000))
        : 500;
      await waitFor(delayMs, request.signal);
      return new Response("slow-complete", {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    return json({ error: "not_found" }, { status: 404 });
  },
};
