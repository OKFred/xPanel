import type { FileReferenceV1, RequestSpecV1 } from "@xpanel/contracts";

export type NativeFilePurpose =
  | "body"
  | "multipart"
  | "ca"
  | "clientCert"
  | "clientKey";

export interface BoundNativeFile {
  file: File;
  purpose: NativeFilePurpose;
  reference: FileReferenceV1;
}

const bindings = new Map<string, File>();

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256File(file: File): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
}

export async function bindFile(
  reference: FileReferenceV1,
  file: File,
): Promise<FileReferenceV1> {
  const updated: FileReferenceV1 = {
    id: reference.id,
    name: file.name,
    size: file.size,
    ...(file.type ? { mediaType: file.type } : {}),
    sha256: await sha256File(file),
    requiresReselection: false,
  };
  bindings.set(reference.id, file);
  return updated;
}

export function unbindFile(referenceId: string): void {
  bindings.delete(referenceId);
}

function addBoundFile(
  result: BoundNativeFile[],
  reference: FileReferenceV1,
  purpose: NativeFilePurpose,
): void {
  if (reference.requiresReselection) {
    throw new Error(
      `${reference.name} must be selected again before Native execution.`,
    );
  }
  const file = bindings.get(reference.id);
  if (!file) {
    throw new Error(
      `${reference.name} must be selected again before Native execution.`,
    );
  }
  result.push({ file, purpose, reference });
}

export function boundFilesForRequest(
  request: RequestSpecV1,
): BoundNativeFile[] {
  const files: BoundNativeFile[] = [];
  if (request.body.kind === "file")
    addBoundFile(files, request.body.file, "body");
  if (request.body.kind === "multipart") {
    for (const part of request.body.parts) {
      if (part.enabled && part.kind === "file")
        addBoundFile(files, part.file, "multipart");
    }
  }
  if (request.options.tls.caFile)
    addBoundFile(files, request.options.tls.caFile, "ca");
  if (request.options.tls.clientCertificate) {
    addBoundFile(
      files,
      request.options.tls.clientCertificate.certificate,
      "clientCert",
    );
    addBoundFile(
      files,
      request.options.tls.clientCertificate.privateKey,
      "clientKey",
    );
  }

  const unique = new Map<string, BoundNativeFile>();
  for (const binding of files) {
    const existing = unique.get(binding.reference.id);
    if (existing && existing.purpose !== binding.purpose) {
      throw new Error(
        `File ${binding.reference.name} is assigned to more than one security role.`,
      );
    }
    unique.set(binding.reference.id, binding);
  }
  return [...unique.values()];
}
