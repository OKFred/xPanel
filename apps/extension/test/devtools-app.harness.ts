import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, type Pinia } from "pinia";
import type { Component, Plugin } from "vue";
import { beforeAll, beforeEach, vi } from "vitest";

import {
  type CollectionRecord,
  type ExecutionEventV1,
  type ExecutionProgressV1,
  type ExecutionSummaryV1,
  type RemoteCapabilitiesV1,
  type RemoteRelayProfileV1,
  type RequestSpecV1,
  type ResponseRecordV1,
  type ResultRetentionV1,
} from "@xpanel/contracts";

import type {
  StartBackgroundExecutionInput,
  StoredResponseMetadata,
} from "../src/lib/execution-client";

export const database = {
  loadWorkspace: vi.fn(async () => ({
    collections: [] as CollectionRecord[],
    requests: [] as RequestSpecV1[],
    warnings: [],
  })),
  saveCollection: vi.fn(async () => undefined),
  saveRequest: vi.fn(async () => undefined),
  saveWorkspace: vi.fn(async () => undefined),
  deleteCollectionFromWorkspace: vi.fn(async () => undefined),
  deleteRequestFromWorkspace: vi.fn(async () => undefined),
};

export const execution = {
  browserUnsupportedReasons: vi.fn<(request: RequestSpecV1) => string[]>(),
  cancelRequest: vi.fn<(requestId: string) => void>(),
  executeRequest: vi.fn<
    (
      request: RequestSpecV1,
      options?: {
        target?:
          | { kind: "browser" }
          | {
              kind: "remote";
              profile: RemoteRelayProfileV1;
              token: string;
            };
        relayPermissionAlreadyGranted?: boolean;
        onProgress?: (progress: ExecutionProgressV1) => void;
      },
    ) => Promise<ResponseRecordV1>
  >(),
  sanitizeBrowserRequestHeaders: vi.fn<
    (request: RequestSpecV1) => {
      request: RequestSpecV1;
      removedHeaders: { name: string; occurrences: number }[];
    }
  >(),
};

export const backgroundExecution = {
  cancelBackgroundExecution: vi.fn<(executionId: string) => Promise<void>>(
    async () => undefined,
  ),
  clearBackgroundExecutionResults: vi.fn(async () => undefined),
  listExecutionSummaries: vi.fn(async () => []),
  loadExecutionPreferences: vi.fn(async () => ({
    schemaVersion: 1 as const,
    retention: "10m" as const,
    responseLimitBytes: 20 * 1024 * 1024,
  })),
  loadExecutionPrettyBody: vi.fn(async () => undefined),
  loadExecutionResponse: vi.fn(),
  loadExecutionResponseBody: vi.fn(),
  loadExecutionResponseMetadata: vi.fn(),
  persistImportedResponse: vi.fn(),
  saveExecutionPreferences: vi.fn(
    async (value: {
      retention: ResultRetentionV1;
      responseLimitBytes: number;
    }) => ({
      schemaVersion: 1 as const,
      ...value,
    }),
  ),
  startBackgroundExecution: vi.fn(),
  subscribeExecutionEvents: vi.fn(),
  listeners: new Set<(event: ExecutionEventV1) => void>(),
  responses: new Map<string, ResponseRecordV1>(),
};

export const remoteProfiles = {
  deleteRelayProfile: vi.fn(async () => undefined),
  ensureRelayPermission: vi.fn(async () => undefined),
  getRelayToken: vi.fn(async () => null as string | null),
  getSessionExecutorSelection: vi.fn(async () => "browser"),
  isRelayTrusted: vi.fn(async () => false),
  loadRelayProfiles: vi.fn(async () => [] as RemoteRelayProfileV1[]),
  revokeRelayTrust: vi.fn(async () => undefined),
  saveRelayProfile: vi.fn(async (profile: RemoteRelayProfileV1) => profile),
  setSessionExecutorSelection: vi.fn(async () => undefined),
  testRelayConnection: vi.fn(
    async () =>
      ({
        protocolVersion: 1,
        provider: "cloudflare",
        targetPolicy: "allowlist",
        maxMetadataBytes: 49_152,
        maxRequestBodyBytes: 20_971_520,
        maxResponseBodyBytes: 20_971_520,
        features: {
          explicitCookie: true,
          responseSetCookie: true,
          files: true,
          multipart: true,
          proxy: false,
          customTls: false,
          clientCertificate: false,
        },
      }) satisfies RemoteCapabilitiesV1,
  ),
  trustRelayForSession: vi.fn<
    (_profile: RemoteRelayProfileV1, _token: string) => Promise<void>
  >(async () => undefined),
};

export const storage = {
  get: vi.fn(async () => ({})),
  remove: vi.fn(async () => undefined),
  set: vi.fn(async () => undefined),
};

let App: Component;
type TestI18n = Plugin & {
  global: { locale: { value: string } };
};
let i18n: TestI18n;

export function responseFor(requestId: string): ResponseRecordV1 {
  return {
    requestId,
    executor: "browser",
    status: 200,
    statusText: "OK",
    headers: [],
    body: {
      kind: "inline",
      encoding: "utf8",
      content: '{"ok":true}',
      mediaType: "application/json",
      sizeBytes: 11,
    },
    timings: {
      startedAt: new Date().toISOString(),
      durationMs: 1,
    },
    redirects: [],
    warnings: [],
  };
}

let executionSequence = 0;

function summaryFor(
  requestId: string,
  executor: "browser" | "remote",
  state: ExecutionSummaryV1["state"],
  progress: ExecutionProgressV1,
  revision: number,
  responseHandle?: string,
): ExecutionSummaryV1 {
  const timestamp = new Date().toISOString();
  return {
    schemaVersion: 1,
    executionId: `execution-${executionSequence}`,
    requestId,
    executor,
    state,
    retention: "10m",
    revision,
    progress,
    ...(responseHandle ? { responseHandle } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function storedMetadata(
  handle: string,
  response: ResponseRecordV1,
): StoredResponseMetadata {
  const { body, ...metadata } = response;
  return {
    ...metadata,
    schemaVersion: 1,
    handle,
    executionId: handle.replace(/^response-/u, ""),
    body: {
      kind: "stored",
      encoding: body.encoding,
      ...(body.mediaType ? { mediaType: body.mediaType } : {}),
      sizeBytes: body.sizeBytes,
      ...(body.sha256 ? { sha256: body.sha256 } : {}),
    },
    createdAt: new Date().toISOString(),
  };
}

function emitExecutionEvent(event: ExecutionEventV1): void {
  for (const listener of backgroundExecution.listeners) listener(event);
}

export async function mountApp(
  pinia: Pinia = createPinia(),
): Promise<VueWrapper> {
  const wrapper = mount(App, {
    global: {
      plugins: [pinia, i18n],
      stubs: {
        ResponseDocumentViewer: {
          props: ["source", "sizeBytes", "mode", "ariaLabel"],
          template: '<pre class="response-document-viewer">{{ source }}</pre>',
        },
      },
    },
  });
  await flushPromises();
  return wrapper;
}

beforeAll(async () => {
  vi.stubGlobal("chrome", {
    devtools: {
      network: {
        getHAR: vi.fn(),
      },
    },
    i18n: {
      getUILanguage: vi.fn(() => "en-US"),
    },
    permissions: {
      contains: vi.fn(async () => false),
      getAll: vi.fn(async () => ({ origins: [] })),
      remove: vi.fn(async () => true),
      request: vi.fn(async () => true),
    },
    storage: {
      local: storage,
    },
  });
  const appModule = (await import("../entrypoints/devtools-panel/App.vue")) as {
    default: Component;
  };
  App = appModule.default;
  i18n = (await import("../src/i18n")).i18n as unknown as TestI18n;
});

beforeEach(() => {
  i18n.global.locale.value = "en-US";
  vi.clearAllMocks();
  executionSequence = 0;
  backgroundExecution.listeners.clear();
  backgroundExecution.responses.clear();
  backgroundExecution.listExecutionSummaries.mockReset();
  backgroundExecution.listExecutionSummaries.mockResolvedValue([]);
  backgroundExecution.loadExecutionPreferences.mockReset();
  backgroundExecution.loadExecutionPreferences.mockResolvedValue({
    schemaVersion: 1,
    retention: "10m",
    responseLimitBytes: 20 * 1024 * 1024,
  });
  backgroundExecution.subscribeExecutionEvents.mockReset();
  backgroundExecution.subscribeExecutionEvents.mockImplementation(
    (listener: (event: ExecutionEventV1) => void) => {
      backgroundExecution.listeners.add(listener);
      return () => backgroundExecution.listeners.delete(listener);
    },
  );
  backgroundExecution.loadExecutionResponse.mockReset();
  backgroundExecution.loadExecutionResponse.mockImplementation(
    async (handle: string) => backgroundExecution.responses.get(handle),
  );
  backgroundExecution.loadExecutionResponseMetadata.mockReset();
  backgroundExecution.loadExecutionResponseMetadata.mockImplementation(
    async (handle: string) => {
      const response = backgroundExecution.responses.get(handle);
      return response ? storedMetadata(handle, response) : undefined;
    },
  );
  backgroundExecution.loadExecutionResponseBody.mockReset();
  backgroundExecution.loadExecutionResponseBody.mockImplementation(
    async (handle: string) => {
      const response = backgroundExecution.responses.get(handle);
      return response
        ? new Blob([response.body.content], {
            type: response.body.mediaType ?? "text/plain",
          })
        : undefined;
    },
  );
  backgroundExecution.loadExecutionPrettyBody.mockReset();
  backgroundExecution.loadExecutionPrettyBody.mockResolvedValue(undefined);
  backgroundExecution.cancelBackgroundExecution.mockReset();
  backgroundExecution.cancelBackgroundExecution.mockImplementation(
    async (executionId: string) => execution.cancelRequest(executionId),
  );
  backgroundExecution.startBackgroundExecution.mockReset();
  backgroundExecution.startBackgroundExecution.mockImplementation(
    async (input: StartBackgroundExecutionInput) => {
      executionSequence += 1;
      const executor = input.target?.kind === "remote" ? "remote" : "browser";
      let revision = 1;
      const response = await execution.executeRequest(input.request, {
        target:
          input.target?.kind === "remote"
            ? {
                kind: "remote",
                profile: input.target.profile,
                token: "relay-secret",
              }
            : { kind: "browser" },
        ...(input.permissionAlreadyGranted === undefined
          ? {}
          : {
              relayPermissionAlreadyGranted: input.permissionAlreadyGranted,
            }),
        onProgress(progress) {
          revision += 1;
          emitExecutionEvent({
            protocolVersion: 1,
            eventId: `event-${executionSequence}-${revision}`,
            type: "execution.progress",
            execution: summaryFor(
              input.request.id,
              executor,
              "running",
              progress,
              revision,
            ),
          });
        },
      });
      const handle = `response-execution-${executionSequence}`;
      backgroundExecution.responses.set(handle, response);
      revision += 1;
      return summaryFor(
        input.request.id,
        executor,
        "succeeded",
        {
          phase: "complete",
          loadedBytes: response.body.sizeBytes,
          totalBytes: response.body.sizeBytes,
          elapsedMs: response.timings.durationMs,
        },
        revision,
        handle,
      );
    },
  );
  execution.executeRequest.mockReset();
  execution.browserUnsupportedReasons.mockReset();
  execution.browserUnsupportedReasons.mockReturnValue([]);
  execution.sanitizeBrowserRequestHeaders.mockReset();
  execution.sanitizeBrowserRequestHeaders.mockImplementation((request) => {
    const sanitized = structuredClone(request);
    const removed = sanitized.headers.filter((header) =>
      ["dnt", "origin"].includes(header.name.toLowerCase()),
    );
    sanitized.headers = sanitized.headers.filter(
      (header) => !["dnt", "origin"].includes(header.name.toLowerCase()),
    );
    return {
      request: sanitized,
      removedHeaders: [...new Set(removed.map((header) => header.name))].map(
        (name) => ({
          name,
          occurrences: removed.filter((header) => header.name === name).length,
        }),
      ),
    };
  });
  remoteProfiles.loadRelayProfiles.mockReset();
  remoteProfiles.loadRelayProfiles.mockResolvedValue([]);
  remoteProfiles.getSessionExecutorSelection.mockReset();
  remoteProfiles.getSessionExecutorSelection.mockResolvedValue("browser");
  remoteProfiles.getRelayToken.mockReset();
  remoteProfiles.getRelayToken.mockResolvedValue(null);
  remoteProfiles.ensureRelayPermission.mockReset();
  remoteProfiles.ensureRelayPermission.mockResolvedValue(undefined);
  remoteProfiles.isRelayTrusted.mockReset();
  remoteProfiles.isRelayTrusted.mockResolvedValue(false);
  remoteProfiles.trustRelayForSession.mockReset();
  remoteProfiles.trustRelayForSession.mockResolvedValue(undefined);
  remoteProfiles.saveRelayProfile.mockReset();
  remoteProfiles.saveRelayProfile.mockImplementation(async (profile) =>
    structuredClone(profile),
  );
  remoteProfiles.testRelayConnection.mockClear();
});
