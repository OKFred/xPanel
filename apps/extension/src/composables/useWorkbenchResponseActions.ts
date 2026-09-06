import type { Ref } from "vue";

import { compactJson, prettyJson } from "@xpanel/request-core";
import type {
  RequestSpecV1,
  ResponseRecordV1,
  ResultRetentionV1,
} from "@xpanel/contracts";

interface WorkbenchResponseActionOptions {
  bodyText: Ref<string>;
  clearResults: () => Promise<void>;
  copied: Ref<string>;
  current: Ref<RequestSpecV1>;
  errorMessage: Ref<string>;
  loadResponse: () => Promise<ResponseRecordV1 | undefined>;
  notice: Ref<string>;
  responseBody: Ref<Blob | null>;
  responseLimitMiB: Ref<number>;
  retention: Ref<ResultRetentionV1>;
  savePreferences: (
    retention: ResultRetentionV1,
    responseLimitMiB: number,
  ) => Promise<void>;
  t: (key: string) => string;
}

export function useWorkbenchResponseActions(
  options: WorkbenchResponseActionOptions,
) {
  function reportError(error: unknown): void {
    options.errorMessage.value =
      error instanceof Error ? error.message : String(error);
  }

  function beautifyBody(): void {
    try {
      options.bodyText.value = prettyJson(options.bodyText.value);
      options.notice.value = options.t("formatted");
    } catch (error) {
      reportError(error);
    }
  }

  function compactBody(): void {
    try {
      options.bodyText.value = compactJson(options.bodyText.value);
      options.notice.value = options.t("compacted");
    } catch (error) {
      reportError(error);
    }
  }

  async function copyText(label: string, value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      options.copied.value = label;
      window.setTimeout(() => {
        if (options.copied.value === label) options.copied.value = "";
      }, 1_500);
    } catch (error) {
      reportError(error);
    }
  }

  async function copyResponseBody(): Promise<void> {
    try {
      const response = await options.loadResponse();
      if (response) await copyText("body", response.body.content);
    } catch (error) {
      reportError(error);
    }
  }

  async function copyFullResponse(): Promise<void> {
    try {
      const response = await options.loadResponse();
      if (!response) return;
      await copyText(
        "full-response",
        [
          `HTTP ${response.status} ${response.statusText}`.trim(),
          response.headers
            .map((header) => `${header.name}: ${header.value}`)
            .join("\n"),
          "",
          response.body.content,
        ].join("\n"),
      );
    } catch (error) {
      reportError(error);
    }
  }

  function downloadResponseBody(): void {
    const blob = options.responseBody.value;
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    const base =
      options.current.value.name.replace(/[^a-z0-9]+/giu, "-").toLowerCase() ||
      "response";
    anchor.download = `${base}.body`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function updateRetention(value: ResultRetentionV1): Promise<void> {
    if (
      value === "manual" &&
      !window.confirm(options.t("manualRetentionWarning"))
    ) {
      return;
    }
    try {
      await options.savePreferences(value, options.responseLimitMiB.value);
    } catch (error) {
      reportError(error);
    }
  }

  async function updateResponseLimit(value: number): Promise<void> {
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      options.errorMessage.value = options.t("responseLimitRange");
      return;
    }
    try {
      await options.savePreferences(options.retention.value, value);
    } catch (error) {
      reportError(error);
    }
  }

  async function clearExecutionResults(): Promise<void> {
    try {
      await options.clearResults();
      options.notice.value = options.t("resultsCleared");
    } catch (error) {
      reportError(error);
    }
  }

  return {
    beautifyBody,
    clearExecutionResults,
    compactBody,
    copyFullResponse,
    copyResponseBody,
    copyText,
    downloadResponseBody,
    updateResponseLimit,
    updateRetention,
  };
}
