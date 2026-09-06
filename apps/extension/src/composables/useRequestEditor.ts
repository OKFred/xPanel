import { computed, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { useI18n } from "vue-i18n";

import type { AuthSpec, BodySpec, FileReferenceV1 } from "@xpanel/contracts";

import { bindFile, unbindFile } from "../lib/file-bindings";
import { useWorkbenchStore } from "../stores/workbench";

const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 86_400_000;
const MIN_TIMEOUT_SECONDS = MIN_TIMEOUT_MS / 1_000;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1_000;

export function useRequestEditor(errorMessage: { value: string }) {
  const store = useWorkbenchStore();
  const { current, notice } = storeToRefs(store);
  const { t } = useI18n();
  const timeoutSecondsInput = ref("");
  const timeoutEditing = ref(false);
  const timeoutRangeMessage = computed(() => t("timeoutRange"));
  const bodyKind = computed(() => current.value.body.kind);
  const bodyText = computed({
    get: () =>
      current.value.body.kind === "json" || current.value.body.kind === "text"
        ? current.value.body.text
        : "",
    set: (text: string) => {
      if (current.value.body.kind === "json" || current.value.body.kind === "text") {
        current.value.body.text = text;
      }
    },
  });
  const hasHiddenBrowserOptions = computed(
    () =>
      current.value.options.proxy !== null ||
      !current.value.options.tls.verify ||
      current.value.options.tls.caFile !== undefined ||
      current.value.options.tls.clientCertificate !== undefined ||
      (current.value.body.kind === "multipart" &&
        current.value.body.parts.some(
          (part) =>
            part.enabled &&
            part.headers?.some(
              (header) => header.enabled && header.name.trim() !== "",
            ),
        )),
  );

  function formatTimeoutSeconds(timeoutMs: number): string {
    return (timeoutMs / 1_000).toString();
  }

  function parseTimeoutSeconds(value: string): number | undefined {
    if (value.trim() === "") return undefined;
    const seconds = Number(value);
    if (
      !Number.isFinite(seconds) ||
      seconds < MIN_TIMEOUT_SECONDS ||
      seconds > MAX_TIMEOUT_SECONDS
    ) {
      return undefined;
    }
    const timeoutMs = Math.round(seconds * 1_000);
    return timeoutMs >= MIN_TIMEOUT_MS && timeoutMs <= MAX_TIMEOUT_MS
      ? timeoutMs
      : undefined;
  }

  function updateTimeoutInput(event: Event): void {
    const value = (event.currentTarget as HTMLInputElement).value;
    timeoutSecondsInput.value = value;
    const timeoutMs = parseTimeoutSeconds(value);
    if (timeoutMs !== undefined) current.value.options.timeoutMs = timeoutMs;
  }

  function normalizeTimeoutInput(): void {
    timeoutEditing.value = false;
    const timeoutMs = parseTimeoutSeconds(timeoutSecondsInput.value);
    if (timeoutMs === undefined) {
      timeoutSecondsInput.value = formatTimeoutSeconds(current.value.options.timeoutMs);
      errorMessage.value = timeoutRangeMessage.value;
      return;
    }
    current.value.options.timeoutMs = timeoutMs;
    timeoutSecondsInput.value = formatTimeoutSeconds(timeoutMs);
    if (errorMessage.value === timeoutRangeMessage.value) errorMessage.value = "";
  }

  function filePlaceholder(name: string): FileReferenceV1 {
    return { id: crypto.randomUUID(), name, requiresReselection: true };
  }

  function addMultipartText(): void {
    if (current.value.body.kind !== "multipart") return;
    current.value.body.parts.push({ kind: "text", name: "", value: "", enabled: true });
  }

  function addMultipartFile(): void {
    if (current.value.body.kind !== "multipart") return;
    current.value.body.parts.push({
      kind: "file",
      name: "file",
      file: filePlaceholder(t("selectFile")),
      enabled: true,
    });
  }

  function removeMultipartPart(index: number): void {
    if (current.value.body.kind !== "multipart") return;
    const part = current.value.body.parts[index];
    if (part?.kind === "file") unbindFile(part.file.id);
    current.value.body.parts.splice(index, 1);
  }

  function selectMultipartFile(index: number, event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file || current.value.body.kind !== "multipart") return;
    const part = current.value.body.parts[index];
    if (part?.kind !== "file") return;
    part.file = bindFile(part.file, file);
  }

  function selectRawBodyFile(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file || current.value.body.kind !== "file") return;
    current.value.body.file = bindFile(current.value.body.file, file);
    if (file.type) current.value.body.mediaType = file.type;
  }

  function clearHiddenBrowserOptions(): void {
    const tls = current.value.options.tls;
    if (tls.caFile) unbindFile(tls.caFile.id);
    if (tls.clientCertificate) {
      unbindFile(tls.clientCertificate.certificate.id);
      unbindFile(tls.clientCertificate.privateKey.id);
    }
    current.value.options.proxy = null;
    current.value.options.tls = { verify: true };
    if (current.value.body.kind === "multipart") {
      for (const part of current.value.body.parts) delete part.headers;
    }
    notice.value = t("clearedUnsupportedOptions");
  }

  function setBodyKind(kind: BodySpec["kind"]): void {
    if (current.value.body.kind === "file") unbindFile(current.value.body.file.id);
    if (current.value.body.kind === "multipart") {
      for (const part of current.value.body.parts) {
        if (part.kind === "file") unbindFile(part.file.id);
      }
    }
    const bodies: Record<BodySpec["kind"], BodySpec> = {
      none: { kind: "none" },
      text: { kind: "text", text: "", mediaType: "text/plain" },
      json: { kind: "json", text: "{}", mediaType: "application/json" },
      file: { kind: "file", file: filePlaceholder(t("selectBodyFile")) },
      urlencoded: { kind: "urlencoded", entries: [] },
      multipart: { kind: "multipart", parts: [] },
    };
    current.value.body = bodies[kind];
  }

  function setAuthKind(kind: AuthSpec["kind"]): void {
    const auth: Record<AuthSpec["kind"], AuthSpec> = {
      none: { kind: "none" },
      basic: { kind: "basic", username: "", password: "" },
      bearer: { kind: "bearer", token: "" },
      "api-key": { kind: "api-key", location: "header", name: "X-API-Key", value: "" },
      oauth2: { kind: "oauth2", accessToken: "", tokenType: "Bearer" },
    };
    current.value.auth = auth[kind];
  }

  watch(timeoutRangeMessage, (nextMessage, previousMessage) => {
    if (errorMessage.value === previousMessage) errorMessage.value = nextMessage;
  });
  watch(
    () => [current.value.id, current.value.options.timeoutMs] as const,
    ([, timeoutMs]) => {
      if (!timeoutEditing.value) timeoutSecondsInput.value = formatTimeoutSeconds(timeoutMs);
    },
    { immediate: true },
  );

  return {
    addMultipartFile,
    addMultipartText,
    bodyKind,
    bodyText,
    clearHiddenBrowserOptions,
    hasHiddenBrowserOptions,
    normalizeTimeoutInput,
    removeMultipartPart,
    selectMultipartFile,
    selectRawBodyFile,
    setAuthKind,
    setBodyKind,
    timeoutEditing,
    timeoutSecondsInput,
    updateTimeoutInput,
  };
}
