import type {
  ExecutionProgressV1,
  RemoteRelayProfileV1,
  ResponseRecordV1,
} from "@xpanel/contracts";

export type ExecuteTargetV1 =
  | { kind: "browser" }
  | {
      kind: "remote";
      profile: RemoteRelayProfileV1;
      token: string;
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
};
