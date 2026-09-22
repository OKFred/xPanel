import type {
  ExecutionProgressV1,
  OneFetchProfileV1,
  OneFetchConsentV1,
  OneFetchResponseDetailsV1,
  ResponseRecordV1,
} from "@xpanel/contracts";

export type ExecuteTargetV1 =
  | { kind: "browser" }
  | {
      kind: "remote";
      profile: OneFetchProfileV1;
      token: string;
      consent: OneFetchConsentV1;
    };

export interface ExecuteOptionsV1 {
  target?: ExecuteTargetV1;
  onProgress?: (progress: ExecutionProgressV1) => void;
  relayPermissionAlreadyGranted?: boolean;
  browserPermissionAlreadyGranted?: boolean;
  relayPermissionPreflighted?: boolean;
  browserPermissionPreflighted?: boolean;
  maximumResponseBytes?: number;
}

export type ExecutionResponseStreamV1 = Omit<ResponseRecordV1, "body"> & {
  stream: ReadableStream<Uint8Array>;
  declaredLength?: number;
  maximumResponseBytes?: number;
  remoteDetails?: OneFetchResponseDetailsV1;
  finalizeRemote?: () => Promise<OneFetchResponseDetailsV1>;
};
