import { createSignedResponseMetadata } from "@one-fetch/core";
import {
  decodeRequestMetadata,
  encodeResponseMetadata,
  ONE_FETCH_LIMITS_V1,
  type OneFetchCapabilitiesV1,
  type OneFetchUnsignedResponseMetaV1,
} from "@one-fetch/protocol";
import { oneFetchProfileV1Schema } from "@xpanel/contracts";
export const token = "synthetic-execution-token-no-real-credentials";
export const fetchInputUrl = (input: RequestInfo | URL): string =>
  input instanceof Request ? input.url : input.toString();
export const consent = {
  instanceId: "fixture",
  pairId: "fixture-pair",
  configVersion: "fixture-1",
  buildVersion: "0.1.1",
};
export function profile(id = crypto.randomUUID()) {
  return oneFetchProfileV1Schema.parse({
    schemaVersion: 1,
    id,
    name: "Synthetic one-fetch",
    controlUrl: "https://control.example/control",
    gatewayUrl: "https://gateway.example/gateway",
    tokenStorage: "session",
  });
}
export function capabilities(): OneFetchCapabilitiesV1 {
  return {
    protocolVersion: 1,
    instanceId: consent.instanceId,
    provider: "node",
    buildVersion: "0.1.1",
    controlGatewayPairId: consent.pairId,
    configVersion: consent.configVersion,
    configUpdatedAt: "2026-09-22T00:00:00Z",
    policyMode: "allowlist",
    transports: {
      http: { state: "stable" },
      websocket: { state: "unsupported" },
      tcp: { state: "unsupported" },
      tls: { state: "unsupported" },
    },
    limits: {
      metadataBytes: ONE_FETCH_LIMITS_V1.metadataBytes,
      requestBodyBytes: ONE_FETCH_LIMITS_V1.requestBodyBytes,
      responseBodyBytes: ONE_FETCH_LIMITS_V1.responseBodyBytes,
      inspectableBodyBytes: ONE_FETCH_LIMITS_V1.inspectableBodyBytes,
      timeoutMs: ONE_FETCH_LIMITS_V1.timeoutMs,
      redirects: ONE_FETCH_LIMITS_V1.redirects,
    },
    fetchOptions: [
      { option: "redirect", fidelity: "translated" },
      { option: "timeoutMs", fidelity: "exact" },
    ],
    headerMutations: [],
    audit: { state: "healthy" },
  };
}
export async function signedResponse(
  init: RequestInit,
  body = "ok",
  extra: Partial<OneFetchUnsignedResponseMetaV1> = {},
  signingToken = token,
): Promise<Response> {
  const request = decodeRequestMetadata(
    new Headers(init.headers).get("One-Fetch-Request")!,
  );
  const unsigned = {
    protocolVersion: 1 as const,
    requestId: request.requestId,
    nonce: request.nonce,
    outcome: "target" as const,
    target: {
      kind: "http" as const,
      status: 200,
      statusText: "OK",
      headers: [{ name: "Content-Type", value: "text/plain" }],
      setCookie: [],
      bodyComplete: true,
    },
    timing: { phases: [], serverTiming: [] },
    configVersionUsed: consent.configVersion,
    mutations: [],
    audit: { state: "recorded" as const },
    ...extra,
  };
  const signed = await createSignedResponseMetadata(
    JSON.parse(JSON.stringify(unsigned)) as OneFetchUnsignedResponseMetaV1,
    signingToken,
  );
  return new Response(body, {
    status: unsigned.target?.kind === "http" ? unsigned.target.status : 502,
    headers: {
      "One-Fetch-Response": encodeResponseMetadata(signed),
      "Content-Type": "text/plain",
    },
  });
}
