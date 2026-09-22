import {
  oneFetchProfileV1Schema,
  remoteRelayProfileV1Schema,
  type OneFetchProfileV1,
  type OneFetchConsentV1,
  type RemoteRelayProfileV1,
} from "@xpanel/contracts";
import { normalizeRelayBaseUrl } from "./one-fetch-connection";
export {
  normalizeRelayBaseUrl,
  ensureRelayPermission,
  testRelayConnection,
  consentIdentity,
  relayPermissionOrigins,
} from "./one-fetch-connection";

const PROFILES_KEY = "oneFetchProfilesV1";
const TOKENS_KEY = "oneFetchTokensV1";
const SELECTION_KEY = "oneFetchExecutorSelectionV1";
const TRUST_KEY = "oneFetchTrustV1";

async function readRecord(
  area: chrome.storage.StorageArea,
  key: string,
): Promise<Record<string, string>> {
  const value: unknown = (await area.get(key))[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export function validateRelayProfile(
  profile: OneFetchProfileV1,
  existing: readonly OneFetchProfileV1[] = [],
): OneFetchProfileV1 {
  const parsed = oneFetchProfileV1Schema.parse({
    ...profile,
    name: profile.name.trim(),
    controlUrl: normalizeRelayBaseUrl(profile.controlUrl),
    gatewayUrl: normalizeRelayBaseUrl(profile.gatewayUrl),
  });
  if (
    existing.some(
      (item) =>
        item.id !== parsed.id &&
        item.name.toLocaleLowerCase() === parsed.name.toLocaleLowerCase(),
    )
  ) {
    throw new Error("A one-fetch profile with this name already exists.");
  }
  return parsed;
}

export async function loadRelayProfiles(): Promise<OneFetchProfileV1[]> {
  const stored: unknown = (await chrome.storage.local.get(PROFILES_KEY))[
    PROFILES_KEY
  ];
  return (Array.isArray(stored) ? stored : []).flatMap((value: unknown) => {
    const result = oneFetchProfileV1Schema.safeParse(value);
    return result.success ? [result.data] : [];
  });
}

export async function getRelayToken(
  profile: OneFetchProfileV1,
): Promise<string | undefined> {
  const parsed = oneFetchProfileV1Schema.parse(profile);
  return (await readRecord(chrome.storage[parsed.tokenStorage], TOKENS_KEY))[
    parsed.id
  ];
}

async function writeToken(
  profile: OneFetchProfileV1,
  token?: string,
): Promise<void> {
  for (const areaName of ["local", "session"] as const) {
    const area = chrome.storage[areaName];
    const tokens = await readRecord(area, TOKENS_KEY);
    delete tokens[profile.id];
    if (profile.tokenStorage === areaName && token?.trim())
      tokens[profile.id] = token;
    await area.set({ [TOKENS_KEY]: tokens });
  }
}

export async function saveRelayProfile(
  profile: OneFetchProfileV1,
  token?: string,
): Promise<OneFetchProfileV1> {
  const profiles = await loadRelayProfiles();
  const parsed = validateRelayProfile(profile, profiles);
  const previous = profiles.find((item) => item.id === parsed.id);
  const effectiveToken =
    token ?? (previous ? await getRelayToken(previous) : undefined);
  if (!effectiveToken?.trim())
    throw new Error("An execution token is required.");
  await revokeRelayTrust(parsed.id);
  await writeToken(parsed, effectiveToken);
  await chrome.storage.local.set({
    [PROFILES_KEY]: [
      ...profiles.filter((item) => item.id !== parsed.id),
      parsed,
    ],
  });
  return parsed;
}

export async function getSessionExecutorSelection(): Promise<string> {
  const value: unknown = (await chrome.storage.session.get(SELECTION_KEY))[
    SELECTION_KEY
  ];
  return typeof value === "string" && value ? value : "browser";
}

export async function setSessionExecutorSelection(
  selection: string,
): Promise<void> {
  await chrome.storage.session.set({ [SELECTION_KEY]: selection });
}

async function fingerprint(
  profile: OneFetchProfileV1,
  token: string,
  consent: OneFetchConsentV1,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ profile: validateRelayProfile(profile), token, consent }),
  );
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function isRelayTrusted(
  profile: OneFetchProfileV1,
  token: string,
  consent: OneFetchConsentV1,
): Promise<boolean> {
  return (
    (await readRecord(chrome.storage.session, TRUST_KEY))[profile.id] ===
    (await fingerprint(profile, token, consent))
  );
}

export async function trustRelayForSession(
  profile: OneFetchProfileV1,
  token: string,
  consent: OneFetchConsentV1,
): Promise<void> {
  const trust = await readRecord(chrome.storage.session, TRUST_KEY);
  trust[profile.id] = await fingerprint(profile, token, consent);
  await chrome.storage.session.set({ [TRUST_KEY]: trust });
}

export async function revokeRelayTrust(profileId?: string): Promise<void> {
  if (!profileId) return chrome.storage.session.remove(TRUST_KEY);
  const trust = await readRecord(chrome.storage.session, TRUST_KEY);
  delete trust[profileId];
  await chrome.storage.session.set({ [TRUST_KEY]: trust });
}

export async function deleteRelayProfile(profileId: string): Promise<void> {
  const profiles = await loadRelayProfiles();
  const profile = profiles.find((item) => item.id === profileId);
  if (profile) await writeToken(profile);
  await revokeRelayTrust(profileId);
  await chrome.storage.local.set({
    [PROFILES_KEY]: profiles.filter((item) => item.id !== profileId),
  });
  if ((await getSessionExecutorSelection()) === profileId)
    await setSessionExecutorSelection("browser");
}

/** Legacy data is visible for cleanup only, never executable or silently migrated. */
export async function loadLegacyRelayProfiles(): Promise<
  RemoteRelayProfileV1[]
> {
  const stored: unknown = (
    await chrome.storage.local.get("remoteRelayProfilesV1")
  ).remoteRelayProfilesV1;
  return (Array.isArray(stored) ? stored : []).flatMap((value: unknown) => {
    const result = remoteRelayProfileV1Schema.safeParse(value);
    return result.success ? [result.data] : [];
  });
}

export async function deleteLegacyRelayProfile(
  profileId: string,
): Promise<void> {
  const profiles = await loadLegacyRelayProfiles();
  await chrome.storage.local.set({
    remoteRelayProfilesV1: profiles.filter((p) => p.id !== profileId),
  });
  for (const area of [chrome.storage.local, chrome.storage.session]) {
    const tokens = await readRecord(area, "remoteRelayTokensV1");
    delete tokens[profileId];
    await area.set({ remoteRelayTokensV1: tokens });
  }
  await chrome.storage.session.remove([
    "remoteExecutorSelectionV1",
    "remoteRelayTrustV1",
  ]);
}
