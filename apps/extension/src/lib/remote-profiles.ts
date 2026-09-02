import {
  REMOTE_MAX_METADATA_BYTES,
  REMOTE_PROTOCOL_VERSION,
  remoteCapabilitiesV1Schema,
  remoteErrorEnvelopeV1Schema,
  remoteRelayProfileV1Schema,
  type RemoteCapabilitiesV1,
  type RemoteRelayProfileV1,
} from "@xpanel/contracts";

const PROFILES_KEY = "remoteRelayProfilesV1";
const TOKENS_KEY = "remoteRelayTokensV1";
const SESSION_SELECTION_KEY = "remoteExecutorSelectionV1";
const SESSION_TRUST_KEY = "remoteRelayTrustV1";
const CAPABILITY_CACHE_TTL_MS = 5 * 60 * 1_000;

interface CapabilityCacheEntry {
  capabilities: RemoteCapabilitiesV1;
  expiresAt: number;
}

const capabilityCache = new Map<string, CapabilityCacheEntry>();

type StringRecord = Record<string, string>;

function invalidateCapabilitiesForProfileId(profileId: string): void {
  for (const key of capabilityCache.keys()) {
    if (key.startsWith(`${profileId}\0`)) capabilityCache.delete(key);
  }
}

function stringRecord(value: unknown): StringRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

async function readRecord(
  area: chrome.storage.StorageArea,
  key: string,
): Promise<StringRecord> {
  const stored = await area.get(key);
  return stringRecord(stored[key]);
}

async function writeRecord(
  area: chrome.storage.StorageArea,
  key: string,
  value: StringRecord,
): Promise<void> {
  await area.set({ [key]: value });
}

export function normalizeRelayBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes("?") || trimmed.includes("#")) {
    throw new Error("Remote relay URLs cannot contain a query or fragment.");
  }
  const parsed = new URL(trimmed);
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
  const normalized =
    parsed.pathname === "/"
      ? parsed.origin
      : `${parsed.origin}${parsed.pathname}`;
  return remoteRelayProfileV1Schema.shape.baseUrl.parse(normalized);
}

export function validateRelayProfile(
  profile: RemoteRelayProfileV1,
  existingProfiles: readonly RemoteRelayProfileV1[] = [],
): RemoteRelayProfileV1 {
  const validated = remoteRelayProfileV1Schema.parse({
    ...profile,
    name: profile.name.trim(),
    baseUrl: normalizeRelayBaseUrl(profile.baseUrl),
  });
  const normalizedName = validated.name.toLocaleLowerCase();
  if (
    existingProfiles.some(
      (candidate) =>
        candidate.id !== validated.id &&
        candidate.name.trim().toLocaleLowerCase() === normalizedName,
    )
  ) {
    throw new Error(
      `A Remote relay profile named "${validated.name}" already exists.`,
    );
  }
  return validated;
}

export async function loadRelayProfiles(): Promise<RemoteRelayProfileV1[]> {
  const stored = await chrome.storage.local.get(PROFILES_KEY);
  const records = Array.isArray(stored[PROFILES_KEY])
    ? stored[PROFILES_KEY]
    : [];
  return records.flatMap((record) => {
    const result = remoteRelayProfileV1Schema.safeParse(record);
    return result.success ? [result.data] : [];
  });
}

async function writeRelayToken(
  profile: RemoteRelayProfileV1,
  token: string | null,
): Promise<void> {
  const [localTokens, sessionTokens] = await Promise.all([
    readRecord(chrome.storage.local, TOKENS_KEY),
    readRecord(chrome.storage.session, TOKENS_KEY),
  ]);
  delete localTokens[profile.id];
  delete sessionTokens[profile.id];
  if (token !== null && token.trim() !== "") {
    const destination =
      profile.tokenStorage === "local" ? localTokens : sessionTokens;
    destination[profile.id] = token;
  }
  await Promise.all([
    writeRecord(chrome.storage.local, TOKENS_KEY, localTokens),
    writeRecord(chrome.storage.session, TOKENS_KEY, sessionTokens),
  ]);
}

export async function getRelayToken(
  profile: RemoteRelayProfileV1,
): Promise<string | undefined> {
  const validated = remoteRelayProfileV1Schema.parse(profile);
  const area =
    validated.tokenStorage === "local"
      ? chrome.storage.local
      : chrome.storage.session;
  const tokens = await readRecord(area, TOKENS_KEY);
  const token = tokens[validated.id];
  return token && token.trim() !== "" ? token : undefined;
}

export async function saveRelayProfile(
  profile: RemoteRelayProfileV1,
  token?: string,
): Promise<RemoteRelayProfileV1> {
  const profiles = await loadRelayProfiles();
  const previous = profiles.find((candidate) => candidate.id === profile.id);
  const previousToken = previous ? await getRelayToken(previous) : null;
  const validated = validateRelayProfile(profile, profiles);
  const effectiveToken = token === undefined ? previousToken : token;
  const connectionChanged =
    previous !== undefined &&
    (normalizeRelayBaseUrl(previous.baseUrl) !== validated.baseUrl ||
      (previousToken ?? "") !== (effectiveToken ?? ""));
  const nextProfiles = profiles.filter(
    (candidate) => candidate.id !== validated.id,
  );
  nextProfiles.push(validated);
  await chrome.storage.local.set({ [PROFILES_KEY]: nextProfiles });
  await writeRelayToken(validated, effectiveToken ?? null);
  if (connectionChanged) {
    await revokeRelayTrust(validated.id);
    invalidateCapabilitiesForProfileId(validated.id);
  }
  return validated;
}

/** "browser" or the concrete Remote relay profile id for this browser session. */
export type SessionExecutorSelection = string;

export async function getSessionExecutorSelection(): Promise<SessionExecutorSelection> {
  const stored = await chrome.storage.session.get(SESSION_SELECTION_KEY);
  const value: unknown = stored[SESSION_SELECTION_KEY];
  if (value === "browser") return value;
  return typeof value === "string" && value.trim() !== "" ? value : "browser";
}

export async function setSessionExecutorSelection(
  selection: SessionExecutorSelection,
): Promise<void> {
  if (selection === "browser") {
    await chrome.storage.session.set({ [SESSION_SELECTION_KEY]: selection });
    return;
  }
  remoteRelayProfileV1Schema.shape.id.parse(selection);
  await chrome.storage.session.set({ [SESSION_SELECTION_KEY]: selection });
}

async function relayFingerprint(
  profile: RemoteRelayProfileV1,
  token: string,
): Promise<string> {
  const validated = remoteRelayProfileV1Schema.parse(profile);
  const bytes = new TextEncoder().encode(
    `${normalizeRelayBaseUrl(validated.baseUrl)}\0${token}`,
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function isRelayTrusted(
  profile: RemoteRelayProfileV1,
  token: string,
): Promise<boolean> {
  const trust = await readRecord(chrome.storage.session, SESSION_TRUST_KEY);
  return trust[profile.id] === (await relayFingerprint(profile, token));
}

export async function trustRelayForSession(
  profile: RemoteRelayProfileV1,
  token: string,
): Promise<void> {
  if (token.trim() === "") throw new Error("A Remote relay token is required.");
  const validated = remoteRelayProfileV1Schema.parse(profile);
  const trust = await readRecord(chrome.storage.session, SESSION_TRUST_KEY);
  trust[validated.id] = await relayFingerprint(validated, token);
  await writeRecord(chrome.storage.session, SESSION_TRUST_KEY, trust);
}

export async function revokeRelayTrust(profileId?: string): Promise<void> {
  if (profileId === undefined) {
    await chrome.storage.session.remove(SESSION_TRUST_KEY);
    return;
  }
  const trust = await readRecord(chrome.storage.session, SESSION_TRUST_KEY);
  delete trust[profileId];
  await writeRecord(chrome.storage.session, SESSION_TRUST_KEY, trust);
}

export async function deleteRelayProfile(profileId: string): Promise<void> {
  remoteRelayProfileV1Schema.shape.id.parse(profileId);
  const profiles = await loadRelayProfiles();
  await chrome.storage.local.set({
    [PROFILES_KEY]: profiles.filter((profile) => profile.id !== profileId),
  });
  const [localTokens, sessionTokens, selection] = await Promise.all([
    readRecord(chrome.storage.local, TOKENS_KEY),
    readRecord(chrome.storage.session, TOKENS_KEY),
    getSessionExecutorSelection(),
  ]);
  delete localTokens[profileId];
  delete sessionTokens[profileId];
  await Promise.all([
    writeRecord(chrome.storage.local, TOKENS_KEY, localTokens),
    writeRecord(chrome.storage.session, TOKENS_KEY, sessionTokens),
    revokeRelayTrust(profileId),
    ...(selection === profileId
      ? [setSessionExecutorSelection("browser")]
      : []),
  ]);
  invalidateCapabilitiesForProfileId(profileId);
}

function relayUrl(profile: RemoteRelayProfileV1, path: string): URL {
  return new URL(`${normalizeRelayBaseUrl(profile.baseUrl)}${path}`);
}

export async function ensureRelayPermission(
  profile: RemoteRelayProfileV1,
): Promise<void> {
  const url = relayUrl(profile, "/v1/capabilities");
  const granted = await chrome.permissions.request({
    origins: [`${url.origin}/*`],
  });
  if (!granted) {
    throw new Error(`Host permission was not granted for relay ${url.origin}.`);
  }
}

async function assertRelayPermission(
  profile: RemoteRelayProfileV1,
): Promise<void> {
  const url = relayUrl(profile, "/v1/capabilities");
  const granted = await chrome.permissions.contains({
    origins: [`${url.origin}/*`],
  });
  if (!granted) {
    throw new Error(`Host permission is no longer granted for ${url.origin}.`);
  }
}

async function cacheKey(
  profile: RemoteRelayProfileV1,
  token: string,
): Promise<string> {
  return `${profile.id}\0${await relayFingerprint(profile, token)}`;
}

export async function invalidateRelayCapabilities(
  profile?: RemoteRelayProfileV1,
  token?: string,
): Promise<void> {
  if (!profile || token === undefined) {
    capabilityCache.clear();
    return;
  }
  capabilityCache.delete(await cacheKey(profile, token));
}

async function parseRelayFailure(response: Response): Promise<Error> {
  let parsed: unknown;
  try {
    const body = await readLimitedMetadataText(response);
    parsed = JSON.parse(body);
  } catch {
    return new Error(`Remote relay failed with HTTP ${response.status}.`);
  }
  const result = remoteErrorEnvelopeV1Schema.safeParse(parsed);
  return result.success
    ? new Error(
        `Remote relay ${result.data.error.code}: ${result.data.error.message}`,
      )
    : new Error(`Remote relay failed with HTTP ${response.status}.`);
}

async function readLimitedMetadataText(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/u.test(declared.trim())) {
    const size = Number(declared);
    if (Number.isSafeInteger(size) && size > REMOTE_MAX_METADATA_BYTES) {
      throw new Error("Remote relay metadata exceeds 48 KiB.");
    }
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > REMOTE_MAX_METADATA_BYTES) {
      throw new Error("Remote relay metadata exceeds 48 KiB.");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > REMOTE_MAX_METADATA_BYTES) {
        await reader.cancel("metadata-too-large");
        throw new Error("Remote relay metadata exceeds 48 KiB.");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function testRelayConnection(
  profile: RemoteRelayProfileV1,
  token: string,
  options: {
    force?: boolean;
    signal?: AbortSignal;
    permissionAlreadyGranted?: boolean;
  } = {},
): Promise<RemoteCapabilitiesV1> {
  const validated = validateRelayProfile(profile);
  if (token.trim() === "") throw new Error("A Remote relay token is required.");
  // Keep the permission prompt as the first asynchronous browser operation in
  // the direct user gesture. WebCrypto and cache lookup happen afterwards.
  if (options.permissionAlreadyGranted) {
    await assertRelayPermission(validated);
  } else {
    await ensureRelayPermission(validated);
  }
  const key = await cacheKey(validated, token);
  const cached = capabilityCache.get(key);
  if (!options.force && cached && cached.expiresAt > Date.now()) {
    return cached.capabilities;
  }
  const response = await fetch(relayUrl(validated, "/v1/capabilities"), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-XPanel-Protocol": String(REMOTE_PROTOCOL_VERSION),
    },
    redirect: "error",
    cache: "no-store",
    credentials: "omit",
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (response.status !== 200) throw await parseRelayFailure(response);
  const text = await readLimitedMetadataText(response);
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new Error("Remote relay returned invalid capability JSON.");
  }
  const capabilities = remoteCapabilitiesV1Schema.parse(decoded);
  capabilityCache.set(key, {
    capabilities,
    expiresAt: Date.now() + CAPABILITY_CACHE_TTL_MS,
  });
  return capabilities;
}
