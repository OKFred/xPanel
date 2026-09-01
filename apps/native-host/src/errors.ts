export type NativeHostErrorCode =
  | "ACK_TIMEOUT"
  | "BAD_FRAME"
  | "BAD_MESSAGE"
  | "CANCELLED"
  | "CHUNK_CHECKSUM"
  | "CHUNK_SEQUENCE"
  | "CHUNK_TOO_LARGE"
  | "CURL_FAILED"
  | "DUPLICATE_REQUEST"
  | "FILE_NOT_READY"
  | "INTERNAL_ERROR"
  | "INLINE_BODY_REQUIRES_TRANSFER"
  | "INVALID_REQUEST"
  | "MISSING_FILE"
  | "NOT_FOUND"
  | "TRANSFER_TOO_LARGE"
  | "UPLOAD_TIMEOUT";

export class NativeHostError extends Error {
  public readonly code: NativeHostErrorCode;
  public readonly retryable: boolean;
  public readonly details: Record<string, unknown> | undefined;

  public constructor(
    code: NativeHostErrorCode,
    message: string,
    options: {
      cause?: unknown;
      details?: Record<string, unknown>;
      retryable?: boolean;
    } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "NativeHostError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function toNativeHostError(error: unknown): NativeHostError {
  if (error instanceof NativeHostError) {
    return error;
  }
  if (error instanceof Error) {
    return new NativeHostError("INTERNAL_ERROR", error.message, {
      cause: error,
    });
  }
  return new NativeHostError(
    "INTERNAL_ERROR",
    "An unknown native host error occurred.",
  );
}
