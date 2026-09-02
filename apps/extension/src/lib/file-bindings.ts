import type { FileReferenceV1, RequestSpecV1 } from "@xpanel/contracts";

export type RequestFilePurpose = "body" | "multipart";

export interface BoundRequestFile {
  file: File;
  purpose: RequestFilePurpose;
  reference: FileReferenceV1;
}

interface FileBinding {
  file: File;
}

const bindings = new Map<string, FileBinding>();

export function bindFile(
  reference: FileReferenceV1,
  file: File,
): FileReferenceV1 {
  const updated: FileReferenceV1 = {
    id: reference.id,
    name: file.name,
    size: file.size,
    ...(file.type ? { mediaType: file.type } : {}),
    requiresReselection: false,
  };
  bindings.set(reference.id, { file });
  return updated;
}

export function unbindFile(referenceId: string): void {
  bindings.delete(referenceId);
}

function addBoundFile(
  result: BoundRequestFile[],
  reference: FileReferenceV1,
  purpose: RequestFilePurpose,
): void {
  if (reference.requiresReselection) {
    throw new Error(`${reference.name} must be selected again before sending.`);
  }
  const binding = bindings.get(reference.id);
  if (
    !binding ||
    binding.file.name !== reference.name ||
    (reference.size !== undefined && binding.file.size !== reference.size)
  ) {
    throw new Error(`${reference.name} must be selected again before sending.`);
  }
  result.push({ file: binding.file, purpose, reference });
}

export function boundFile(reference: FileReferenceV1): File {
  const result: BoundRequestFile[] = [];
  addBoundFile(result, reference, "body");
  return result[0]!.file;
}

export function boundFilesForRequest(
  request: RequestSpecV1,
): BoundRequestFile[] {
  const files: BoundRequestFile[] = [];
  if (request.body.kind === "file")
    addBoundFile(files, request.body.file, "body");
  if (request.body.kind === "multipart") {
    for (const part of request.body.parts) {
      if (part.enabled && part.kind === "file")
        addBoundFile(files, part.file, "multipart");
    }
  }
  const unique = new Map<string, BoundRequestFile>();
  for (const binding of files) {
    const existing = unique.get(binding.reference.id);
    if (existing && existing.purpose !== binding.purpose) {
      throw new Error(
        `File ${binding.reference.name} is assigned to more than one request role.`,
      );
    }
    unique.set(binding.reference.id, binding);
  }
  return [...unique.values()];
}
