import { handleConformanceTarget } from "@one-fetch/conformance";

// A regular errored ReadableStream can be normalized to a complete short body
// by Workers. FixedLengthStream preserves the promised wire length instead.
export default {
  fetch(request, _env, ctx) {
    if (new URL(request.url).pathname !== "/truncated-fixed")
      return handleConformanceTarget(request);
    const { readable, writable } = new globalThis.FixedLengthStream(14);
    const writer = writable.getWriter();
    ctx.waitUntil(
      (async () => {
        try {
          await writer.write(new TextEncoder().encode("partial"));
          await new Promise((done) => setTimeout(done, 250));
          await writer.close(); // Deliberately shorter than the advertised length.
        } catch {
          // Expected injection, no persistent logs or request data.
        } finally {
          writer.releaseLock();
        }
      })(),
    );
    return new Response(readable, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store",
      },
    });
  },
};
