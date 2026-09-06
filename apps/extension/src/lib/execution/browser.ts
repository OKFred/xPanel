import type { RequestSpecV1, ResponseRecordV1 } from "@xpanel/contracts";

import { boundFilesForRequest } from "../file-bindings";
import {
  beginExecution,
  finishExecution,
  normalizeExecutionError,
  reportProgress,
} from "./active";
import { browserBodySize, browserRequestBody } from "./browser-body";
import {
  assertBrowserSupported,
  browserRequestHeaders,
} from "./browser-headers";
import { requestUrl, resolveMaximumResponseBytes } from "./common";
import { materializeResponse } from "./materialize";
import { createManagedResponseStream } from "./response-stream";
import type { ExecuteOptionsV1, ExecutionResponseStreamV1 } from "./types";

async function ensureOriginPermission(
  url: URL,
  permissionAlreadyGranted: boolean,
): Promise<void> {
  const origins = [`${url.protocol}//${url.host}/*`];
  // A direct panel click must request first to retain user activation. Offscreen
  // callers preflight permission and are restricted to a contains() check here.
  const granted = permissionAlreadyGranted
    ? await chrome.permissions.contains({ origins })
    : await chrome.permissions.request({ origins });
  if (!granted) {
    throw new Error(`Host permission was not granted for ${url.origin}.`);
  }
}

export async function openBrowserResponse(
  request: RequestSpecV1,
  options: ExecuteOptionsV1 = {},
): Promise<ExecutionResponseStreamV1> {
  assertBrowserSupported(request);
  boundFilesForRequest(request);
  const url = requestUrl(request);
  const maximumResponseBytes = resolveMaximumResponseBytes(
    options.maximumResponseBytes,
  );
  const execution = beginExecution(
    request.id,
    request.options.timeoutMs,
    options,
  );
  const { controller } = execution;
  reportProgress(execution, "preparing", 0);

  try {
    reportProgress(execution, "requesting-permission", 0);
    await ensureOriginPermission(
      url,
      options.browserPermissionAlreadyGranted === true,
    );
    if (controller.signal.aborted) {
      throw new DOMException("Request cancelled.", "AbortError");
    }
    const startedAt = new Date().toISOString();
    const start = performance.now();
    const headers = browserRequestHeaders(request);
    const bodyResult = browserRequestBody(request, headers);
    const redirects: ResponseRecordV1["redirects"] = [];
    let nextRequestUrl = url;
    let method = request.method;
    let body = bodyResult.body;
    let nextHeaders = headers;
    let credentials: RequestCredentials = request.options.cookieMode;
    let response: Response;

    const uploadBytes = browserBodySize(body);
    reportProgress(execution, "uploading", 0, uploadBytes);
    reportProgress(execution, "waiting", 0, uploadBytes);
    for (;;) {
      response = await fetch(nextRequestUrl, {
        method,
        headers: nextHeaders,
        ...(body === undefined ? {} : { body }),
        credentials,
        redirect:
          request.options.redirect === "follow"
            ? "manual"
            : request.options.redirect,
        signal: controller.signal,
        cache: "no-store",
      });
      if (
        request.options.redirect !== "follow" ||
        ![301, 302, 303, 307, 308].includes(response.status)
      ) {
        break;
      }
      if (response.type === "opaqueredirect" || response.status === 0) {
        throw new Error(
          "Browser Fetch cannot inspect this cross-origin redirect. Send the redirected URL explicitly.",
        );
      }
      const location = response.headers.get("location");
      if (!location) break;
      if (redirects.length >= 20) {
        throw new Error("The request exceeded 20 redirects.");
      }

      const redirectUrl = new URL(location, nextRequestUrl);
      const redirectedHeaders = new Headers(nextHeaders);
      const dropsBody =
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) &&
          method === "POST");

      if (redirectUrl.origin !== nextRequestUrl.origin) {
        if (body !== undefined && !dropsBody) {
          throw new Error(
            "A cross-origin redirect attempted to replay the request body. Send the redirected URL explicitly after reviewing it.",
          );
        }
        for (const name of [...redirectedHeaders.keys()]) {
          redirectedHeaders.delete(name);
        }
        credentials = "omit";
        const hasPermission = await chrome.permissions.contains({
          origins: [`${redirectUrl.origin}/*`],
        });
        if (!hasPermission) {
          throw new Error(
            `The request redirected to ${redirectUrl.origin}. Review that origin and send it explicitly to grant access.`,
          );
        }
      }

      redirects.push({
        url: redirectUrl.toString(),
        status: response.status,
        method,
      });
      if (dropsBody) {
        method = method === "HEAD" ? "HEAD" : "GET";
        body = undefined;
        redirectedHeaders.delete("content-type");
        redirectedHeaders.delete("content-length");
      }
      nextRequestUrl = redirectUrl;
      nextHeaders = redirectedHeaders;
    }

    const responseHeaders = [...response.headers.entries()].map(
      ([name, value]) => ({ name, value, enabled: true }),
    );
    const timings = {
      startedAt,
      durationMs: performance.now() - start,
    };
    const managed = createManagedResponseStream({
      response,
      execution,
      maximumBytes: maximumResponseBytes,
      limitMessage: "Response body exceeds the configured Browser limit.",
      onFinalize: () => {
        timings.durationMs = performance.now() - start;
      },
    });
    return {
      requestId: request.id,
      executor: "browser",
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      timings,
      redirects,
      warnings: bodyResult.warnings,
      stream: managed.stream,
      ...(managed.declaredLength === undefined
        ? {}
        : { declaredLength: managed.declaredLength }),
      maximumResponseBytes,
    };
  } catch (error) {
    finishExecution(execution);
    throw normalizeExecutionError(execution, error);
  }
}

export async function executeBrowser(
  request: RequestSpecV1,
  options: ExecuteOptionsV1 = {},
): Promise<ResponseRecordV1> {
  return materializeResponse(await openBrowserResponse(request, options));
}
