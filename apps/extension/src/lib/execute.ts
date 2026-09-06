import type { RequestSpecV1, ResponseRecordV1 } from "@xpanel/contracts";

import { openBrowserResponse } from "./execution/browser";
import { materializeResponse } from "./execution/materialize";
import { openRemoteResponse } from "./execution/remote";
import type {
  ExecuteOptionsV1,
  ExecutionResponseStreamV1,
} from "./execution/types";

export { cancelRequest, isRequestCancelling } from "./execution/active";
export { executeBrowser } from "./execution/browser";
export {
  browserUnsupportedReasons,
  sanitizeBrowserRequestHeaders,
} from "./execution/browser-headers";
export type {
  BrowserHeaderSanitizationResult,
  RemovedBrowserHeader,
} from "./execution/browser-headers";
export { executeRemote } from "./execution/remote";
export { remoteUnsupportedReasons } from "./execution/remote-headers";
export { RemoteExecutionError } from "./execution/remote-protocol";
export type {
  ExecuteOptionsV1,
  ExecuteTargetV1,
  ExecutionResponseStreamV1,
} from "./execution/types";

export function executeRequestStream(
  request: RequestSpecV1,
  options: ExecuteOptionsV1 = {},
): Promise<ExecutionResponseStreamV1> {
  const target = options.target ?? { kind: "browser" };
  return target.kind === "remote"
    ? openRemoteResponse(request, target, options)
    : openBrowserResponse(request, options);
}

export async function executeRequest(
  request: RequestSpecV1,
  options: ExecuteOptionsV1 = {},
): Promise<ResponseRecordV1> {
  return materializeResponse(await executeRequestStream(request, options));
}
