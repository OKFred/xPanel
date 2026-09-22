import { computed, ref, shallowRef, shallowReactive, watch } from "vue";
import { UserDenyRulesV1Schema } from "@one-fetch/protocol";
import { useI18n } from "vue-i18n";

import {
  type OneFetchCapabilitiesV1,
  type OneFetchProfileV1,
  oneFetchProfileV1Schema,
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
  loadLegacyRelayProfiles,
  deleteLegacyRelayProfile,
  validateRelayProfile,
} from "../lib/one-fetch-profiles";

function blankRelayDraft(): OneFetchProfileV1 {
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name: "",
    controlUrl: "https://",
    gatewayUrl: "https://",
    tokenStorage: "session",
    allowLoopbackHttp: false,
    userDenyRules: { schemaVersion: 1, rules: [] },
  };
}

export function useRelayWorkbench() {
  const { t } = useI18n();
  const relayProfiles = shallowRef<OneFetchProfileV1[]>([]);
  const legacyProfiles = ref<
    Awaited<ReturnType<typeof loadLegacyRelayProfiles>>
  >([]);
  const executorSelection = ref("browser");
  const sessionSelectionReady = ref(false);
  const relayManagerOpen = ref(false);
  const relayManagerBusy = ref(false);
  const relayManagerError = ref("");
  const relayManagerNotice = ref("");
  const relayCapabilities = shallowRef<OneFetchCapabilitiesV1 | null>(null);
  const relayPersistConfirmed = ref(false);
  const relayDraftOriginalStorage = ref<"session" | "local" | null>(null);
  const relayTokenInput = ref("");
  const relayDraft = shallowRef<OneFetchProfileV1>(
    shallowReactive(blankRelayDraft()),
  );
  const relayRulesText = ref(
    JSON.stringify({ schemaVersion: 1, rules: [] }, null, 2),
  );
  const selectedRelayProfile = computed(() =>
    executorSelection.value === "browser"
      ? undefined
      : relayProfiles.value.find(
          (profile) => profile.id === executorSelection.value,
        ),
  );

  async function refreshRelayProfiles(): Promise<void> {
    relayProfiles.value = await loadRelayProfiles();
    legacyProfiles.value = await loadLegacyRelayProfiles();
    if (
      executorSelection.value !== "browser" &&
      !relayProfiles.value.some(
        (profile) => profile.id === executorSelection.value,
      )
    ) {
      executorSelection.value = "browser";
    }
  }

  function startNewRelayProfile(): void {
    relayDraft.value = shallowReactive(blankRelayDraft());
    relayRulesText.value = JSON.stringify(
      relayDraft.value.userDenyRules,
      null,
      2,
    );
    relayDraftOriginalStorage.value = null;
    relayTokenInput.value = "";
    relayPersistConfirmed.value = false;
    relayCapabilities.value = null;
    relayManagerError.value = "";
    relayManagerNotice.value = "";
  }

  function editRelayProfile(profile: OneFetchProfileV1): void {
    relayDraft.value = shallowReactive(oneFetchProfileV1Schema.parse(profile));
    relayRulesText.value = JSON.stringify(profile.userDenyRules, null, 2);
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
  ): OneFetchProfileV1 | undefined {
    relayManagerError.value = "";
    const name = relayDraft.value.name.trim();
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
    if (
      enforcePersistenceConfirmation &&
      relayDraft.value.tokenStorage === "local" &&
      (relayDraftOriginalStorage.value !== "local" ||
        relayTokenInput.value.trim() !== "") &&
      !relayPersistConfirmed.value
    ) {
      relayManagerError.value = t("relayPersistConfirm");
      return undefined;
    }
    try {
      return validateRelayProfile(
        {
          ...relayDraft.value,
          name,
          userDenyRules: UserDenyRulesV1Schema.parse(
            JSON.parse(relayRulesText.value),
          ),
        },
        relayProfiles.value,
      );
    } catch (error) {
      relayManagerError.value =
        error instanceof Error ? error.message : String(error);
      return undefined;
    }
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
      relayManagerError.value =
        error instanceof Error ? error.message : String(error);
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
      relayManagerNotice.value = t("oneFetchConnectionReady");
    } catch (error) {
      relayManagerError.value =
        error instanceof Error ? error.message : String(error);
    } finally {
      relayManagerBusy.value = false;
    }
  }

  async function removeRelayProfile(profile: OneFetchProfileV1): Promise<void> {
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
      if (executorSelection.value === profile.id)
        executorSelection.value = "browser";
      await refreshRelayProfiles();
      startNewRelayProfile();
      relayManagerNotice.value = t("relayDeleted", { name: profile.name });
    } catch (error) {
      relayManagerError.value =
        error instanceof Error ? error.message : String(error);
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

  async function removeLegacyProfile(profileId: string): Promise<void> {
    if (!window.confirm(t("oneFetchDeleteLegacyConfirm"))) return;
    await deleteLegacyRelayProfile(profileId);
    await refreshRelayProfiles();
  }

  watch(executorSelection, async (value) => {
    if (sessionSelectionReady.value) await setSessionExecutorSelection(value);
  });

  return {
    legacyProfiles,
    relayRulesText,
    removeLegacyProfile,
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
