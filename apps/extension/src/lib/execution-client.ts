import {
  EXECUTION_PROTOCOL_VERSION,
  executionCommandResultV1Schema,
  remoteRelayProfileV1Schema,
  requestSpecV1Schema,
  type ExecutionCommandV1,
  type ExecutionEventV1,
  type ExecutionSummaryV1,
  type RemoteRelayProfileV1,
  type RequestSpecV1,
  type ResultRetentionV1,
} from "@xpanel/contracts";

import { browserUnsupportedReasons, remoteUnsupportedReasons } from "./execute";
import { storeDetachedExecutionResponse } from "./execution-detached-response";
import { boundFilesForRequest } from "./file-bindings";
import {
  failExecution,
  listExecutionSummaries,
  stageExecution,
} from "./execution-repository";
import {
  loadExecutionPrettyBody,
  loadExecutionResponse,
  loadExecutionResponseBody,
  loadExecutionResponseMetadata,
} from "./execution-response-store";
import {
  controlEnvelope,
  executionEventEnvelopeSchema,
} from "./execution-messages";
import { executionSessionId } from "./execution-session";
import {
  DEFAULT_RESPONSE_LIMIT_BYTES,
  executionPreferencesV1Schema,
  type ExecutionPreferencesV1,
  type StoredResponseMetadata,
} from "./execution-storage";

export const EXECUTION_PREFERENCES_KEY = "executionPreferencesV1";
const STORAGE_RESERVE_BYTES = 1024 * 1024;

export class StorageCapacityError extends Error {
  readonly code = "storage_full";

  constructor() {
    super(
      "There is not enough extension storage for this request and response limit. Clear saved execution results or choose a smaller limit.",
    );
    this.name = "StorageCapacityError";
  }
}

export type BackgroundExecutionTarget =
  | { kind: "browser" }
  | { kind: "remote"; profile: RemoteRelayProfileV1 };

export interface StartBackgroundExecutionInput {
  request: RequestSpecV1;
  target?: BackgroundExecutionTarget;
  retention?: ResultRetentionV1;
  responseLimitBytes?: number;
  permissionAlreadyGranted?: boolean;
}

function commandId(): string {
  return crypto.randomUUID();
}

async function sendCommand(command: ExecutionCommandV1): Promise<void> {
  const raw: unknown = await chrome.runtime.sendMessage(
    controlEnvelope(command),
  );
  const result = executionCommandResultV1Schema.parse(raw);
  if (!result.accepted) {
    throw new Error(
      result.error?.message ?? "Background command was rejected.",
    );
  }
}

function permissionPattern(
  target: BackgroundExecutionTarget,
  request: RequestSpecV1,
): string {
  const url =
    target.kind === "browser"
      ? new URL(request.url)
      : new URL(target.profile.baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Background requests require an HTTP or HTTPS URL.");
  }
  return `${url.protocol}//${url.host}/*`;
}

export async function ensureExecutionHostPermission(
  target: BackgroundExecutionTarget,
  request: RequestSpecV1,
  alreadyGranted = false,
): Promise<void> {
  const permissions = { origins: [permissionPattern(target, request)] };
  const granted = alreadyGranted
    ? await chrome.permissions.contains(permissions)
    : await chrome.permissions.request(permissions);
  if (!granted) throw new Error("Host permission was not granted.");
}

function assertSupported(
  target: BackgroundExecutionTarget,
  request: RequestSpecV1,
): void {
  const reasons =
    target.kind === "browser"
      ? browserUnsupportedReasons(request)
      : remoteUnsupportedReasons(request);
  if (reasons.length > 0) {
    throw new Error(
      `${target.kind === "browser" ? "Browser Fetch" : "Remote relay"} cannot preserve this request because it uses ${reasons.join(
        ", ",
      )}.`,
    );
  }
}

export function requiredExecutionStorageBytes(
  request: RequestSpecV1,
  files: readonly File[],
  responseLimitBytes: number,
): number {
  const requestBytes = new TextEncoder().encode(
    JSON.stringify(request),
  ).byteLength;
  const fileBytes = files.reduce((total, file) => total + file.size, 0);
  const reserve = Math.max(
    STORAGE_RESERVE_BYTES,
    Math.ceil(responseLimitBytes * 0.1),
  );
  return requestBytes + fileBytes + responseLimitBytes + reserve;
}

async function ensureStorageCapacity(requiredBytes: number): Promise<void> {
  if (!navigator.storage?.estimate) return;
  assertExecutionStorageCapacity(
    await navigator.storage.estimate(),
    requiredBytes,
  );
}

export function assertExecutionStorageCapacity(
  estimate: Pick<StorageEstimate, "quota" | "usage">,
  requiredBytes: number,
): void {
  if (estimate.quota === undefined || estimate.usage === undefined) return;
  if (estimate.quota - estimate.usage < requiredBytes) {
    throw new StorageCapacityError();
  }
}

export async function loadExecutionPreferences(): Promise<ExecutionPreferencesV1> {
  const stored = await chrome.storage.local.get(EXECUTION_PREFERENCES_KEY);
  const parsed = executionPreferencesV1Schema.safeParse(
    stored[EXECUTION_PREFERENCES_KEY],
  );
  return parsed.success
    ? parsed.data
    : {
        schemaVersion: 1,
        retention: "10m",
        responseLimitBytes: DEFAULT_RESPONSE_LIMIT_BYTES,
      };
}

export async function saveExecutionPreferences(
  preferences: Omit<ExecutionPreferencesV1, "schemaVersion">,
): Promise<ExecutionPreferencesV1> {
  const validated = executionPreferencesV1Schema.parse({
    schemaVersion: 1,
    ...preferences,
  });
  await chrome.storage.local.set({ [EXECUTION_PREFERENCES_KEY]: validated });
  return validated;
}

export async function persistImportedResponse(
  response: Parameters<typeof storeDetachedExecutionResponse>[0],
  retention?: ResultRetentionV1,
): Promise<ExecutionSummaryV1> {
  const preferences = await loadExecutionPreferences();
  return storeDetachedExecutionResponse(
    response,
    retention ?? preferences.retention,
    await executionSessionId(),
  );
}

export async function startBackgroundExecution(
  input: StartBackgroundExecutionInput,
): Promise<ExecutionSummaryV1> {
  const request = requestSpecV1Schema.parse(input.request);
  const target = input.target ?? { kind: "browser" };
  const validatedTarget =
    target.kind === "browser"
      ? target
      : {
          kind: "remote" as const,
          profile: remoteRelayProfileV1Schema.parse(target.profile),
        };
  assertSupported(validatedTarget, request);
  const boundFiles = boundFilesForRequest(request);

  // permissions.request must be the first awaited Chrome call in the click chain.
  await ensureExecutionHostPermission(
    validatedTarget,
    request,
    input.permissionAlreadyGranted,
  );

  const preferences = await loadExecutionPreferences();
  const responseLimitBytes =
    input.responseLimitBytes ?? preferences.responseLimitBytes;
  await ensureStorageCapacity(
    requiredExecutionStorageBytes(
      request,
      boundFiles.map(({ file }) => file),
      responseLimitBytes,
    ),
  );
  const sessionId = await executionSessionId();
  const staged = await stageExecution(
    {
      request,
      target:
        validatedTarget.kind === "browser"
          ? { kind: "browser" }
          : { kind: "remote", profileId: validatedTarget.profile.id },
      retention: input.retention ?? preferences.retention,
      responseLimitBytes,
    },
    sessionId,
    boundFiles.map(({ reference, file }) => ({
      referenceId: reference.id,
      file,
    })),
  );
  const command: ExecutionCommandV1 = {
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    commandId: commandId(),
    type: "execution.start",
    executionId: staged.summary.executionId,
    payloadHandle: staged.payloadHandle,
  };
  try {
    await sendCommand(command);
  } catch (error) {
    await failExecution(
      staged.summary.executionId,
      staged.payloadHandle,
      "failed",
      {
        code: "start_failed",
        message:
          error instanceof Error ? error.message : "Background start failed.",
      },
    );
    throw error;
  }
  const summaries = await listExecutionSummaries();
  return (
    summaries.find(
      (summary) => summary.executionId === staged.summary.executionId,
    ) ?? staged.summary
  );
}

export async function cancelBackgroundExecution(
  executionId: string,
): Promise<void> {
  await sendCommand({
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    commandId: commandId(),
    type: "execution.cancel",
    executionId,
  });
}

export async function clearBackgroundExecutionResults(
  options: {
    executionIds?: string[];
    expiredOnly?: boolean;
  } = {},
): Promise<void> {
  await sendCommand({
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    commandId: commandId(),
    type: "execution.clear",
    ...(options.executionIds ? { executionIds: options.executionIds } : {}),
    ...(options.expiredOnly === undefined
      ? {}
      : { expiredOnly: options.expiredOnly }),
  });
}

export function subscribeExecutionEvents(
  listener: (event: ExecutionEventV1) => void,
): () => void {
  const runtimeListener = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
  ): void => {
    if (sender.id !== chrome.runtime.id) return;
    const parsed = executionEventEnvelopeSchema.safeParse(message);
    if (parsed.success) listener(parsed.data.event);
  };
  chrome.runtime.onMessage.addListener(runtimeListener);
  void sendCommand({
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    commandId: commandId(),
    type: "execution.subscribe",
  }).catch(() => undefined);
  return () => chrome.runtime.onMessage.removeListener(runtimeListener);
}

export {
  listExecutionSummaries,
  loadExecutionResponse,
  loadExecutionResponseBody,
  loadExecutionResponseMetadata,
  loadExecutionPrettyBody,
};
export type { StoredResponseMetadata };
