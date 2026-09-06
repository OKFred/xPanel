import {
  responseRecordV1Schema,
  type ResponseBody,
  type ResponseRecordV1,
} from "@xpanel/contracts";

import { database } from "./database";
import {
  storedResponseBodySchema,
  storedResponseMetadataSchema,
  type StoredResponseBody,
  type StoredResponseMetadata,
} from "./execution-storage";

export type ResponseMetadataV1 = Omit<ResponseRecordV1, "body">;
export type StoredBodyDescriptor = Omit<ResponseBody, "kind" | "content"> & {
  kind: "stored";
};

interface StoredResponseRecords {
  metadata: StoredResponseMetadata;
  body: StoredResponseBody;
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function createStoredResponseRecords(input: {
  executionId: string;
  responseHandle: string;
  response: ResponseRecordV1;
  createdAt: string;
  expiresAt?: string;
}): { metadata: StoredResponseMetadata; body: StoredResponseBody } {
  const validated = responseRecordV1Schema.parse(input.response);
  const { body: inlineBody, ...responseMetadata } = validated;
  const content =
    inlineBody.encoding === "utf8"
      ? inlineBody.content
      : decodeBase64(inlineBody.content);
  const blob = new Blob([content], {
    type: inlineBody.mediaType ?? "application/octet-stream",
  });
  return createStoredResponseRecordsFromBlob({
    ...input,
    response: responseMetadata,
    body: {
      kind: "stored",
      encoding: inlineBody.encoding,
      ...(inlineBody.mediaType ? { mediaType: inlineBody.mediaType } : {}),
      sizeBytes: inlineBody.sizeBytes,
      ...(inlineBody.sha256 ? { sha256: inlineBody.sha256 } : {}),
    },
    blob,
  });
}

export function createStoredResponseRecordsFromBlob(input: {
  executionId: string;
  responseHandle: string;
  response: ResponseMetadataV1;
  body: StoredBodyDescriptor;
  blob: Blob;
  prettyBlob?: Blob;
  presentation?: StoredResponseMetadata["presentation"];
  createdAt: string;
  expiresAt?: string;
}): { metadata: StoredResponseMetadata; body: StoredResponseBody } {
  if (input.blob.size !== input.body.sizeBytes) {
    throw new Error("Stored response size does not match its body metadata.");
  }
  const common = {
    schemaVersion: 1 as const,
    handle: input.responseHandle,
    executionId: input.executionId,
    createdAt: input.createdAt,
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  };
  return {
    metadata: storedResponseMetadataSchema.parse({
      ...input.response,
      ...common,
      body: input.body,
      ...(input.presentation ? { presentation: input.presentation } : {}),
    }),
    body: storedResponseBodySchema.parse({
      ...common,
      blob: input.blob,
      ...(input.prettyBlob ? { prettyBlob: input.prettyBlob } : {}),
    }),
  };
}

export function validateStoredResponseRecords(
  responseHandle: string,
  metadataValue: unknown,
  bodyValue: unknown,
): StoredResponseRecords {
  const metadata = storedResponseMetadataSchema.parse(metadataValue);
  const bodyResult = storedResponseBodySchema.safeParse(bodyValue);
  if (!bodyResult.success) {
    throw new Error(
      `Stored response ${responseHandle} has invalid body data.`,
      {
        cause: bodyResult.error,
      },
    );
  }
  const body = bodyResult.data;
  if (metadata.handle !== responseHandle || body.handle !== responseHandle) {
    throw new Error(
      `Stored response ${responseHandle} has a mismatched handle.`,
    );
  }
  if (metadata.executionId !== body.executionId) {
    throw new Error(
      `Stored response ${responseHandle} has a mismatched execution association.`,
    );
  }
  if (body.blob.size !== metadata.body.sizeBytes) {
    throw new Error(
      `Stored response ${responseHandle} size does not match its metadata.`,
    );
  }
  return { metadata, body };
}

async function loadStoredResponseRecords(
  responseHandle: string,
): Promise<StoredResponseRecords | undefined> {
  const db = await database();
  const [metadataValue, bodyValue] = await Promise.all([
    db.get("execution-responses", responseHandle),
    db.get("execution-bodies", responseHandle),
  ]);
  if (metadataValue === undefined && bodyValue === undefined) return undefined;
  if (metadataValue === undefined || bodyValue === undefined) {
    throw new Error(`Stored response ${responseHandle} is incomplete.`);
  }
  return validateStoredResponseRecords(
    responseHandle,
    metadataValue,
    bodyValue,
  );
}

export async function loadExecutionResponseMetadata(
  responseHandle: string,
): Promise<StoredResponseMetadata | undefined> {
  return (await loadStoredResponseRecords(responseHandle))?.metadata;
}

export async function loadExecutionResponseBody(
  responseHandle: string,
): Promise<Blob | undefined> {
  return (await loadStoredResponseRecords(responseHandle))?.body.blob;
}

export async function loadExecutionPrettyBody(
  responseHandle: string,
): Promise<Blob | undefined> {
  return (await loadStoredResponseRecords(responseHandle))?.body.prettyBlob;
}

export async function loadExecutionResponse(
  responseHandle: string,
): Promise<ResponseRecordV1 | undefined> {
  const records = await loadStoredResponseRecords(responseHandle);
  if (!records) return undefined;
  const { metadata, body: bodyValue } = records;
  const { body, ...stored } = metadata;
  const response: ResponseMetadataV1 = {
    requestId: stored.requestId,
    executor: stored.executor,
    status: stored.status,
    statusText: stored.statusText,
    headers: stored.headers,
    timings: stored.timings,
    redirects: stored.redirects,
    warnings: stored.warnings,
  };
  const content =
    body.encoding === "utf8"
      ? await bodyValue.blob.text()
      : encodeBase64(new Uint8Array(await bodyValue.blob.arrayBuffer()));
  return responseRecordV1Schema.parse({
    ...response,
    body: {
      kind: "inline",
      encoding: body.encoding,
      content,
      ...(body.mediaType ? { mediaType: body.mediaType } : {}),
      sizeBytes: body.sizeBytes,
      ...(body.sha256 ? { sha256: body.sha256 } : {}),
    },
  });
}
