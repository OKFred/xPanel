export const NATIVE_PROTOCOL_VERSION = 1 as const;
export const NATIVE_MESSAGE_LIMIT_BYTES = 1024 * 1024;
export const TRANSFER_CHUNK_LIMIT_BYTES = 512 * 1024;
export const INLINE_REQUEST_BODY_LIMIT_BYTES = 512 * 1024;
export const INLINE_BODY_LIMIT_BYTES = 192 * 1024;
export const MAX_TRANSFER_BYTES = 512 * 1024 * 1024;
export const RESPONSE_ACK_TIMEOUT_MS = 30_000;
export const UPLOAD_IDLE_TIMEOUT_MS = 5 * 60_000;
export const HOST_NAME = "com.okfred.xpanel";
export const HOST_VERSION = "2.0.0";

export const HOST_CAPABILITIES = [
  "curl",
  "cancel",
  "chunked-upload",
  "chunked-response",
  "response-ack",
  "proxy",
  "tls-files",
] as const;
