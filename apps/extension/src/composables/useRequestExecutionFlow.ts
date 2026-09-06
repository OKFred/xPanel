import { computed, nextTick, ref, shallowRef, type Ref } from "vue";

import {
  requestSpecV1Schema,
  type ExecutionWarning,
  type RemoteRelayProfileV1,
  type RequestSpecV1,
} from "@xpanel/contracts";

import {
  browserUnsupportedReasons,
  sanitizeBrowserRequestHeaders,
} from "../lib/execute";
import {
  ensureRelayPermission,
  getRelayToken,
  isRelayTrusted,
  trustRelayForSession,
} from "../lib/remote-profiles";
import type { BackgroundExecutionTarget } from "../lib/execution-client";

interface BrowserFilteredResult {
  request: RequestSpecV1;
  notice: string;
  warning?: ExecutionWarning;
}

interface ExecutionFlowOptions {
  current: Ref<RequestSpecV1>;
  busy: Ref<boolean>;
  notice: Ref<string>;
  errorMessage: Ref<string>;
  autoFilterBrowserHeaders: Ref<boolean>;
  executorSelection: Ref<string>;
  relayProfiles: Ref<RemoteRelayProfileV1[]>;
  selectedRelayProfile: Ref<RemoteRelayProfileV1 | undefined>;
  openRelayManager: () => Promise<void>;
  editRelayProfile: (profile: RemoteRelayProfileV1) => void;
  run: (input: {
    request: RequestSpecV1;
    target: BackgroundExecutionTarget;
    notice?: string;
    warning?: ExecutionWarning;
  }) => Promise<void>;
  t: (key: string, values?: Record<string, unknown>) => string;
}

export function useRequestExecutionFlow(options: ExecutionFlowOptions) {
  const remoteConsentOpen = ref(false);
  const remoteConsentBusy = ref(false);
  const remoteConsentError = ref("");
  const remoteTrustSession = ref(false);
  const pendingRemoteSend = shallowRef<{
    request: RequestSpecV1;
    profile: RemoteRelayProfileV1;
    token: string;
  } | null>(null);
  const browserCompatibilityOpen = ref(false);
  const pendingBrowserRequest = shallowRef<RequestSpecV1 | null>(null);
  const browserCompatibilityReasons = ref<string[]>([]);

  const remoteConsentTarget = computed(() => {
    try {
      return new URL(pendingRemoteSend.value?.request.url ?? "").origin;
    } catch {
      return pendingRemoteSend.value?.request.url ?? "";
    }
  });
  const remoteConsentRelay = computed(() => {
    try {
      return new URL(pendingRemoteSend.value?.profile.baseUrl ?? "").host;
    } catch {
      return pendingRemoteSend.value?.profile.baseUrl ?? "";
    }
  });
  const browserFilterableHeaderCount = computed(() => {
    if (
      !pendingBrowserRequest.value ||
      options.autoFilterBrowserHeaders.value
    ) {
      return 0;
    }
    return sanitizeBrowserRequestHeaders(
      pendingBrowserRequest.value,
    ).removedHeaders.reduce(
      (total, header) => total + header.occurrences,
      0,
    );
  });

  function filterBrowserExecutionCopy(
    request: RequestSpecV1,
  ): BrowserFilteredResult {
    const sanitized = sanitizeBrowserRequestHeaders(request);
    if (sanitized.removedHeaders.length === 0) {
      return { request: sanitized.request, notice: "" };
    }
    const count = sanitized.removedHeaders.reduce(
      (total, header) => total + header.occurrences,
      0,
    );
    const headers = sanitized.removedHeaders
      .map((header) => header.name)
      .join(", ");
    return {
      request: sanitized.request,
      notice: options.t("browserHeadersFilteredNotice", { count, headers }),
      warning: {
        code: "browser.headers_filtered",
        message: options.t("browserHeadersFilteredWarning", { count, headers }),
        path: "headers",
      },
    };
  }

  async function run(
    request: RequestSpecV1,
    target: BackgroundExecutionTarget,
    filtered: BrowserFilteredResult = { request, notice: "" },
  ): Promise<void> {
    await options.run({
      request: filtered.request,
      target,
      notice: filtered.notice,
      ...(filtered.warning ? { warning: filtered.warning } : {}),
    });
  }

  async function send(): Promise<void> {
    if (options.busy.value) return;
    options.errorMessage.value = "";
    options.notice.value = "";
    if (!options.current.value.url.trim()) {
      options.errorMessage.value = options.t("enterUrl");
      return;
    }

    let request: RequestSpecV1;
    try {
      request = requestSpecV1Schema.parse(options.current.value);
    } catch (error) {
      options.errorMessage.value =
        error instanceof Error ? error.message : String(error);
      return;
    }
    if (options.executorSelection.value === "browser") {
      const filtered = options.autoFilterBrowserHeaders.value
        ? filterBrowserExecutionCopy(request)
        : { request, notice: "" };
      const reasons = browserUnsupportedReasons(filtered.request);
      if (reasons.length > 0) {
        pendingBrowserRequest.value = request;
        browserCompatibilityReasons.value = reasons;
        browserCompatibilityOpen.value = true;
        return;
      }
      await run(request, { kind: "browser" }, filtered);
      return;
    }

    const profile = options.selectedRelayProfile.value;
    if (!profile) {
      options.executorSelection.value = "browser";
      options.errorMessage.value = options.t("noRelayProfiles");
      return;
    }
    try {
      await ensureRelayPermission(profile);
      const token = await getRelayToken(profile);
      if (!token) {
        options.errorMessage.value = options.t("relayTokenRequired");
        await options.openRelayManager();
        options.editRelayProfile(profile);
        return;
      }
      if (!(await isRelayTrusted(profile, token))) {
        pendingRemoteSend.value = { request, profile, token };
        remoteTrustSession.value = false;
        remoteConsentError.value = "";
        remoteConsentOpen.value = true;
        return;
      }
      await run(request, { kind: "remote", profile });
    } catch (error) {
      options.errorMessage.value =
        error instanceof Error ? error.message : String(error);
    }
  }

  async function filterAndSendBrowserOnce(): Promise<void> {
    const request = pendingBrowserRequest.value;
    if (!request) return;
    const filtered = filterBrowserExecutionCopy(request);
    const remaining = browserUnsupportedReasons(filtered.request);
    browserCompatibilityOpen.value = false;
    pendingBrowserRequest.value = null;
    if (remaining.length > 0) {
      options.errorMessage.value = options.t("browserCannotPreserve", {
        reasons: remaining.join(", "),
      });
      options.notice.value = filtered.notice;
      return;
    }
    await run(request, { kind: "browser" }, filtered);
  }

  async function chooseRemoteFromCompatibility(): Promise<void> {
    browserCompatibilityOpen.value = false;
    pendingBrowserRequest.value = null;
    if (options.relayProfiles.value.length === 0) {
      await nextTick();
      await options.openRelayManager();
      return;
    }
    options.executorSelection.value = options.relayProfiles.value[0]!.id;
    options.notice.value = options.t("remoteNotAutomatic");
  }

  function closeBrowserCompatibility(): void {
    browserCompatibilityOpen.value = false;
    pendingBrowserRequest.value = null;
  }

  async function confirmRemoteSend(): Promise<void> {
    if (remoteConsentBusy.value) return;
    const pending = pendingRemoteSend.value;
    if (!pending) return;
    remoteConsentBusy.value = true;
    remoteConsentError.value = "";
    try {
      if (remoteTrustSession.value) {
        await trustRelayForSession(pending.profile, pending.token);
      }
      remoteConsentOpen.value = false;
      pendingRemoteSend.value = null;
      await run(pending.request, {
        kind: "remote",
        profile: pending.profile,
      });
    } catch (error) {
      remoteConsentError.value =
        error instanceof Error ? error.message : String(error);
    } finally {
      remoteConsentBusy.value = false;
    }
  }

  function closeRemoteConsent(): void {
    if (remoteConsentBusy.value) return;
    remoteConsentOpen.value = false;
    pendingRemoteSend.value = null;
    remoteTrustSession.value = false;
    remoteConsentError.value = "";
  }

  return {
    browserCompatibilityOpen,
    browserCompatibilityReasons,
    browserFilterableHeaderCount,
    chooseRemoteFromCompatibility,
    closeBrowserCompatibility,
    closeRemoteConsent,
    confirmRemoteSend,
    filterAndSendBrowserOnce,
    pendingRemoteSend,
    remoteConsentBusy,
    remoteConsentError,
    remoteConsentOpen,
    remoteConsentRelay,
    remoteConsentTarget,
    remoteTrustSession,
    send,
  };
}
