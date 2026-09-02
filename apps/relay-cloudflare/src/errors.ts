import {
  REMOTE_PROTOCOL_VERSION,
  remoteErrorEnvelopeV1Schema,
  type RemoteErrorCodeV1,
  type RemoteErrorEnvelopeV1,
} from "@xpanel/contracts";

export class RelayError extends Error {
  readonly code: RemoteErrorCodeV1;
  readonly status: number;
  readonly requestId?: string;

  constructor(
    status: number,
    code: RemoteErrorCodeV1,
    message: string,
    requestId?: string,
  ) {
    super(message);
    this.name = "RelayError";
    this.status = status;
    this.code = code;
    if (requestId !== undefined) this.requestId = requestId;
  }
}

export function relayErrorEnvelope(error: RelayError): RemoteErrorEnvelopeV1 {
  return remoteErrorEnvelopeV1Schema.parse({
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    error: {
      code: error.code,
      message: error.message,
    },
  });
}

export function asRelayError(error: unknown): RelayError {
  if (error instanceof RelayError) return error;
  return new RelayError(
    500,
    "internal",
    "The relay could not complete the request.",
  );
}
