import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import {
  type RemoteCapabilitiesV1,
  type RemoteRelayProfileV1,
  remoteRelayProfileV1Schema,
} from "@xpanel/contracts";

import {
  deleteRelayProfile,
  ensureRelayPermission,
  getRelayToken,
  getSessionExecutorSelection,
  loadRelayProfiles,
  revokeRelayTrust,
  saveRelayProfile,
  setSessionExecutorSelection,
  testRelayConnection,
} from "../lib/remote-profiles";

function normalizeRelayBaseUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.includes("?") || trimmed.includes("#")) return undefined;
  try {
    const url = new URL(trimmed);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    url.pathname = url.pathname.replace(/\/+$/u, "");
    return url.href.replace(/\/$/u, "");
  } catch {
    return undefined;
  }
}

function blankRelayDraft(): RemoteRelayProfileV1 {
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name: "",
    baseUrl: "https://",
    tokenStorage: "session",
  };
}

export function useRelayWorkbench() {
  const { t } = useI18n();
  const relayProfiles = ref<RemoteRelayProfileV1[]>([]);
  const executorSelection = ref("browser");
  const sessionSelectionReady = ref(false);
  const relayManagerOpen = ref(false);
  const relayManagerBusy = ref(false);
  const relayManagerError = ref("");
  const relayManagerNotice = ref("");
  const relayCapabilities = ref<RemoteCapabilitiesV1 | null>(null);
  const relayPersistConfirmed = ref(false);
  const relayDraftOriginalStorage = ref<"session" | "local" | null>(null);
  const relayTokenInput = ref("");
  const relayDraft = ref<RemoteRelayProfileV1>(blankRelayDraft());
  const selectedRelayProfile = computed(() =>
    executorSelection.value === "browser"
      ? undefined
      : relayProfiles.value.find((profile) => profile.id === executorSelection.value),
  );

  async function refreshRelayProfiles(): Promise<void> {
    relayProfiles.value = await loadRelayProfiles();
    if (
      executorSelection.value !== "browser" &&
      !relayProfiles.value.some((profile) => profile.id === executorSelection.value)
    ) {
      executorSelection.value = "browser";
    }
  }

  function startNewRelayProfile(): void {
    relayDraft.value = blankRelayDraft();
    relayDraftOriginalStorage.value = null;
    relayTokenInput.value = "";
    relayPersistConfirmed.value = false;
    relayCapabilities.value = null;
    relayManagerError.value = "";
    relayManagerNotice.value = "";
  }

  function editRelayProfile(profile: RemoteRelayProfileV1): void {
    relayDraft.value = remoteRelayProfileV1Schema.parse(profile);
    relayDraftOriginalStorage.value = profile.tokenStorage;
    relayTokenInput.value = "";
    relayPersistConfirmed.value = false;
    relayCapabilities.value = null;
    relayManagerError.value = "";
    relayManagerNotice.value = "";
  }

  async function openRelayManager(): Promise<void> {
    relayManagerOpen.value = true;
    await refreshRelayProfiles();
    const selected = selectedRelayProfile.value ?? relayProfiles.value[0];
    if (selected) editRelayProfile(selected);
    else startNewRelayProfile();
  }

  function closeRelayManager(): void {
    if (relayManagerBusy.value) return;
    relayManagerOpen.value = false;
    relayManagerError.value = "";
    relayManagerNotice.value = "";
  }

  async function relayTokenForDraft(): Promise<string | undefined> {
    const entered = relayTokenInput.value.trim();
    if (entered) return entered;
    const existing = relayProfiles.value.find(
      (profile) => profile.id === relayDraft.value.id,
    );
    return existing ? getRelayToken(existing) : undefined;
  }

  function validatedRelayDraft(
    enforcePersistenceConfirmation = false,
  ): RemoteRelayProfileV1 | undefined {
    relayManagerError.value = "";
    const name = relayDraft.value.name.trim();
    const baseUrl = normalizeRelayBaseUrl(relayDraft.value.baseUrl);
    if (!name) {
      relayManagerError.value = t("relayProfileName");
      return undefined;
    }
    if (
      relayProfiles.value.some(
        (profile) =>
          profile.id !== relayDraft.value.id &&
          profile.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase(),
      )
    ) {
      relayManagerError.value = t("relayNameUnique");
      return undefined;
    }
    if (!baseUrl) {
      relayManagerError.value = t("relayUrlInvalid");
      return undefined;
    }
    if (
      enforcePersistenceConfirmation &&
      relayDraft.value.tokenStorage === "local" &&
      (relayDraftOriginalStorage.value !== "local" || relayTokenInput.value.trim() !== "") &&
      !relayPersistConfirmed.value
    ) {
      relayManagerError.value = t("relayPersistConfirm");
      return undefined;
    }
    return { ...relayDraft.value, name, baseUrl };
  }

  async function saveRelayDraft(): Promise<void> {
    const profile = validatedRelayDraft(true);
    if (!profile || relayManagerBusy.value) return;
    relayManagerBusy.value = true;
    relayManagerNotice.value = "";
    try {
      const token = await relayTokenForDraft();
      if (!token) throw new Error(t("relayTokenRequired"));
      await saveRelayProfile(profile, token);
      await refreshRelayProfiles();
      const saved = relayProfiles.value.find((item) => item.id === profile.id);
      if (saved) editRelayProfile(saved);
      relayManagerNotice.value = t("relaySaved", { name: profile.name });
    } catch (error) {
      relayManagerError.value = error instanceof Error ? error.message : String(error);
    } finally {
      relayManagerBusy.value = false;
    }
  }

  async function testRelayDraft(): Promise<void> {
    const profile = validatedRelayDraft();
    if (!profile || relayManagerBusy.value) return;
    relayManagerBusy.value = true;
    relayManagerNotice.value = "";
    relayCapabilities.value = null;
    try {
      await ensureRelayPermission(profile);
      const token = await relayTokenForDraft();
      if (!token) throw new Error(t("relayTokenRequired"));
      relayCapabilities.value = await testRelayConnection(profile, token, {
        force: true,
        permissionAlreadyGranted: true,
      });
      relayManagerNotice.value = t("connectionReady", {
        policy: relayCapabilities.value.targetPolicy,
        limit: formatBytes(relayCapabilities.value.maxRequestBodyBytes),
      });
    } catch (error) {
      relayManagerError.value = error instanceof Error ? error.message : String(error);
    } finally {
      relayManagerBusy.value = false;
    }
  }

  async function removeRelayProfile(profile: RemoteRelayProfileV1): Promise<void> {
    if (
      relayManagerBusy.value ||
      !window.confirm(`${t("deleteRelayProfile")}: ${profile.name}?`)
    ) {
      return;
    }
    relayManagerBusy.value = true;
    try {
      await deleteRelayProfile(profile.id);
      await revokeRelayTrust(profile.id);
      if (executorSelection.value === profile.id) executorSelection.value = "browser";
      await refreshRelayProfiles();
      startNewRelayProfile();
      relayManagerNotice.value = t("relayDeleted", { name: profile.name });
    } catch (error) {
      relayManagerError.value = error instanceof Error ? error.message : String(error);
    } finally {
      relayManagerBusy.value = false;
    }
  }

  async function initializeRelayState(): Promise<void> {
    await refreshRelayProfiles();
    const savedExecutor = await getSessionExecutorSelection();
    executorSelection.value =
      savedExecutor !== "browser" &&
      relayProfiles.value.some((profile) => profile.id === savedExecutor)
        ? savedExecutor
        : "browser";
    sessionSelectionReady.value = true;
  }

  watch(executorSelection, async (value) => {
    if (sessionSelectionReady.value) await setSessionExecutorSelection(value);
  });

  return {
    closeRelayManager,
    editRelayProfile,
    executorSelection,
    initializeRelayState,
    openRelayManager,
    refreshRelayProfiles,
    relayCapabilities,
    relayDraft,
    relayManagerBusy,
    relayManagerError,
    relayManagerNotice,
    relayManagerOpen,
    relayPersistConfirmed,
    relayProfiles,
    relayTokenInput,
    removeRelayProfile,
    saveRelayDraft,
    selectedRelayProfile,
    startNewRelayProfile,
    testRelayDraft,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}
