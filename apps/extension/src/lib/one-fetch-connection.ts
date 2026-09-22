import { OneFetchControlClient } from "@one-fetch/client";
import type { OneFetchCapabilitiesV1 } from "@one-fetch/protocol";
import {
  oneFetchServiceUrlSchema,
  type OneFetchProfileV1,
  type OneFetchConsentV1,
} from "@xpanel/contracts";

export function normalizeRelayBaseUrl(value: string): string {
  const validated = oneFetchServiceUrlSchema.parse(value.trim());
  const url = new URL(validated);
  return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
}

export function relayPermissionOrigins(profile: OneFetchProfileV1): string[] {
  return [
    ...new Set(
      [profile.controlUrl, profile.gatewayUrl].map(
        (url) => `${new URL(url).origin}/*`,
      ),
    ),
  ];
}

export async function ensureRelayPermission(
  profile: OneFetchProfileV1,
): Promise<void> {
  if (
    !(await chrome.permissions.request({
      origins: relayPermissionOrigins(profile),
    }))
  ) {
    throw new Error(
      "Host access was not granted for the one-fetch Control/Gateway services.",
    );
  }
}

/** Capabilities are public. Never send the execution token to a discovery URL. */
export const controlFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, {
    ...init,
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
  });
  const reader = response.body?.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    if (reader)
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > 48 * 1024) {
          await reader.cancel("metadata-too-large");
          throw new Error("one-fetch Control metadata exceeds 48 KiB.");
        }
        chunks.push(new Uint8Array(item.value));
      }
  } finally {
    reader?.releaseLock();
  }
  return new Response(new Blob(chunks), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

export function consentIdentity(
  capabilities: OneFetchCapabilitiesV1,
): OneFetchConsentV1 {
  return {
    instanceId: capabilities.instanceId,
    pairId: capabilities.controlGatewayPairId,
    configVersion: capabilities.configVersion,
    buildVersion: capabilities.buildVersion,
  };
}

export function assertSameConsent(
  expected: OneFetchConsentV1,
  actual: OneFetchCapabilitiesV1,
): void {
  const current = consentIdentity(actual);
  if (
    expected.instanceId !== current.instanceId ||
    expected.pairId !== current.pairId ||
    expected.configVersion !== current.configVersion ||
    expected.buildVersion !== current.buildVersion
  ) {
    throw new Error(
      "one-fetch configuration changed. Review the service and confirm sending again.",
    );
  }
}

export async function testRelayConnection(
  profile: OneFetchProfileV1,
  _token: string,
  options: {
    force?: boolean;
    signal?: AbortSignal;
    permissionAlreadyGranted?: boolean;
    permissionPreflighted?: boolean;
  } = {},
): Promise<OneFetchCapabilitiesV1> {
  if (!options.permissionPreflighted) {
    if (options.permissionAlreadyGranted) {
      if (
        !(await chrome.permissions.contains({
          origins: relayPermissionOrigins(profile),
        }))
      ) {
        throw new Error("one-fetch host access is no longer granted.");
      }
    } else await ensureRelayPermission(profile);
  }
  const timeout = AbortSignal.timeout(10_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  const client = new OneFetchControlClient({
    controlUrl: profile.controlUrl,
    fetch: (input, init) => controlFetch(input, { ...init, signal }),
  });
  const capabilities = await client.getCapabilities();
  if (capabilities.transports.http?.state !== "stable") {
    throw new Error("The service does not advertise stable HTTP support.");
  }
  if (
    !capabilities.fetchOptions.some(
      (option) =>
        option.option === "adapter.browserResponse" &&
        option.fidelity === "translated" &&
        option.acceptedValues?.includes("envelope-v1"),
    )
  ) {
    throw new Error(
      "This service lacks the browser response envelope required by xPanel. Upgrade one-fetch to 0.1.2 or later with envelope-v1 support.",
    );
  }
  return capabilities;
}
