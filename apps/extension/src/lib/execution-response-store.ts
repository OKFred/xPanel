import {
  responseRecordV1Schema,
  type ResponseBody,
  type ResponseRecordV1,
} from "@xpanel/contracts";

import { database } from "./database";
import {
  isStoredBlob,
  storedResponseMetadataSchema,
  type StoredResponseBody,
  type StoredResponseMetadata,
} from "./execution-storage";

export type ResponseMetadataV1 = Omit<ResponseRecordV1, "body">;
export type StoredBodyDescriptor = Omit<ResponseBody, "kind" | "content"> & {
  kind: "stored";
};

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
    body: {
      ...common,
      blob: input.blob,
      ...(input.prettyBlob ? { prettyBlob: input.prettyBlob } : {}),
    },
  };
}

export async function loadExecutionResponseMetadata(
  responseHandle: string,
): Promise<StoredResponseMetadata | undefined> {
  const db = await database();
  const record = await db.get("execution-responses", responseHandle);
  return record ? storedResponseMetadataSchema.parse(record) : undefined;
}

export async function loadExecutionResponseBody(
  responseHandle: string,
): Promise<Blob | undefined> {
  const db = await database();
  const record = await db.get("execution-bodies", responseHandle);
  if (!record) return undefined;
  if (!isStoredBlob(record.blob)) {
    throw new Error(`Stored response ${responseHandle} has an invalid body.`);
  }
  return record.blob;
}

export async function loadExecutionPrettyBody(
  responseHandle: string,
): Promise<Blob | undefined> {
  const db = await database();
  const record = await db.get("execution-bodies", responseHandle);
  if (!record?.prettyBlob) return undefined;
  if (!isStoredBlob(record.prettyBlob)) {
    throw new Error(
      `Stored response ${responseHandle} has invalid pretty data.`,
    );
  }
  return record.prettyBlob;
}

export async function loadExecutionResponse(
  responseHandle: string,
): Promise<ResponseRecordV1 | undefined> {
  const db = await database();
  const [metadataValue, bodyValue] = await Promise.all([
    db.get("execution-responses", responseHandle),
    db.get("execution-bodies", responseHandle),
  ]);
  if (!metadataValue || !bodyValue) return undefined;
  const metadata = storedResponseMetadataSchema.parse(metadataValue);
  if (!isStoredBlob(bodyValue.blob)) {
    throw new Error(`Stored response ${responseHandle} has an invalid body.`);
  }
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
