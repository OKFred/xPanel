import { OneFetchControlClient } from "@one-fetch/client";
import type {
  OneFetchProfileV1,
  OneFetchResponseDetailsV1,
} from "@xpanel/contracts";
import { controlFetch } from "../one-fetch-connection";

/** Short, bounded verification. Report failure must not become fake success. */
export async function finalizeRemoteReport(
  details: OneFetchResponseDetailsV1,
  profile: OneFetchProfileV1,
  token: string,
  requestId: string,
  loadedBytes: number,
  signal: AbortSignal,
  expectedTargetStatus: number,
): Promise<OneFetchResponseDetailsV1> {
  if (details.source !== "target" || !details.reportId)
    return { ...details, integrity: "unverified" };
  const client = new OneFetchControlClient({
    controlUrl: profile.controlUrl,
    fetch: controlFetch,
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    signal.throwIfAborted();
    try {
      const report = await client.getExecutionReport(details.reportId, token, {
        // Cross-region Control cold starts can exceed two seconds. Still bounded
        // by three attempts and the execution's overall timeout/cancel signal.
        signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      });
      if (
        report.requestId !== requestId ||
        report.reportId !== details.reportId ||
        report.status !== expectedTargetStatus
      ) {
        return {
          ...details,
          integrity: "failed",
          reason: "report-identity-mismatch",
        };
      }
      const complete =
        report.source === "target" &&
        report.outcome === "completed" &&
        report.bodyComplete &&
        report.responseBytes === loadedBytes;
      return {
        ...details,
        timing: report.timing,
        audit: report.auditState,
        integrity: complete
          ? report.bodySha256
            ? "pending"
            : "unverified"
          : "failed",
        ...(report.bodySha256 ? { bodySha256: report.bodySha256 } : {}),
        ...(complete && !report.bodySha256
          ? { reason: "report-digest-unavailable" }
          : {}),
        ...(report.problem ? { problem: report.problem } : {}),
        ...(!complete ? { reason: `report-${report.outcome}` } : {}),
      };
    } catch {
      signal.throwIfAborted();
      if (attempt < 2)
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  }
  return { ...details, integrity: "unverified", reason: "report-unavailable" };
}

export function safeOuterHeaders(
  headers: Headers,
): Array<{ name: string; value: string }> {
  return [...headers]
    .filter(
      ([name]) =>
        !/(?:cookie|authorization|token|secret)|^(?:x-)?one-fetch-/iu.test(
          name,
        ),
    )
    .slice(0, 256)
    .map(([name, value]) => ({ name, value }));
}

/** Bound unverified provider pages without interpreting their content as HTML. */
export function diagnosticResponse(
  response: Response,
  maximum = 1024 * 1024,
): Response {
  // Fetch forbids even an empty stream on these statuses. Preserve unsigned
  // no-content responses as diagnostics instead of throwing while wrapping.
  if (!response.body) return response;
  const reader = response.body?.getReader();
  let bytes = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const item = await reader?.read();
      if (!item || item.done) {
        reader?.releaseLock();
        controller.close();
        return;
      }
      const chunk = item.value.subarray(0, maximum - bytes);
      bytes += chunk.byteLength;
      controller.enqueue(chunk);
      if (bytes >= maximum) {
        await reader?.cancel();
        reader?.releaseLock();
        controller.close();
      }
    },
    async cancel(reason) {
      await reader?.cancel(reason);
      reader?.releaseLock();
    },
  });
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
