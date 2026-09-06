import { computed, type Ref } from "vue";

import type { ExecutionProgressV1 } from "@xpanel/contracts";

interface ResponsePresentation {
  headers: Array<{ name: string; value: string }>;
  timings: unknown;
}

interface WorkbenchPresentationOptions {
  notice: Ref<string>;
  progress: Ref<ExecutionProgressV1 | null>;
  response: Ref<ResponsePresentation | null>;
  t: (key: string, values?: Record<string, unknown>) => string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}

function formatElapsed(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1_000).toFixed(1)} s`;
}

export function useWorkbenchPresentation(
  options: WorkbenchPresentationOptions,
) {
  const displayedNotice = computed(() => {
    const value = options.notice.value;
    let match = value.match(
      /^(\d+) invalid saved record\(s\) were ignored\. Import a backup if data is missing\.$/u,
    );
    if (match) {
      return options.t("invalidSavedRecords", { count: Number(match[1]) });
    }
    if (value === "Deleted saved request.") {
      return options.t("deletedSavedRequest");
    }
    match = value.match(
      /^Deleted collection and (\d+) exclusive requests?; shared requests were kept\.$/u,
    );
    if (match) {
      return options.t("deletedCollectionCascade", {
        count: Number(match[1]),
      });
    }
    if (
      value ===
      "Deleted collection; its exclusive requests were moved to My requests."
    ) {
      return options.t("deletedCollectionMoved");
    }
    if (value === "Deleted collection; shared requests were kept.") {
      return options.t("deletedCollectionShared");
    }
    if (value === "Deleted collection.") {
      return options.t("deletedCollection");
    }
    if (value === "Saved locally with sensitive values.") {
      return options.t("savedWithSensitive");
    }
    if (value === "Saved locally with sensitive values redacted.") {
      return options.t("savedWithRedaction");
    }
    match = value.match(/^Imported (\d+) requests?\.$/u);
    return match
      ? options.t("importedRequests", { count: Number(match[1]) })
      : value;
  });

  const progressPercent = computed(() => {
    const progress = options.progress.value;
    if (
      !progress ||
      progress.totalBytes === undefined ||
      progress.phase === "uploading" ||
      progress.phase === "waiting" ||
      progress.phase === "requesting-permission"
    ) {
      return undefined;
    }
    if (progress.totalBytes === 0) {
      return progress.phase === "complete" ? 100 : 0;
    }
    return Math.min(100, (progress.loadedBytes / progress.totalBytes) * 100);
  });

  const progressPhaseLabel = computed(() => {
    const phase = options.progress.value?.phase;
    if (!phase) return "";
    const keys: Record<ExecutionProgressV1["phase"], string> = {
      preparing: "progressPreparing",
      "requesting-permission": "progressRequestingPermission",
      uploading: "progressUploading",
      waiting: "progressWaiting",
      downloading: "progressDownloading",
      cancelling: "progressCancelling",
      complete: "progressComplete",
    };
    return options.t(keys[phase]);
  });

  const progressDetail = computed(() => {
    const progress = options.progress.value;
    if (!progress) return "";
    const elapsed = formatElapsed(progress.elapsedMs);
    if (progress.phase === "uploading" && progress.totalBytes !== undefined) {
      return options.t("progressBodySize", {
        total: formatBytes(progress.totalBytes),
        elapsed,
      });
    }
    return progress.totalBytes === undefined
      ? options.t("progressTransferred", {
          bytes: formatBytes(progress.loadedBytes),
          elapsed,
        })
      : options.t("progressTransferredOf", {
          loaded: formatBytes(progress.loadedBytes),
          total: formatBytes(progress.totalBytes),
          elapsed,
        });
  });

  const responseHeaders = computed(
    () =>
      options.response.value?.headers
        .map((header) => `${header.name}: ${header.value}`)
        .join("\n") ?? "",
  );
  const responseTiming = computed(() =>
    options.response.value
      ? JSON.stringify(options.response.value.timings, null, 2)
      : "",
  );

  return {
    displayedNotice,
    progressDetail,
    progressPercent,
    progressPhaseLabel,
    responseHeaders,
    responseTiming,
  };
}
