import {
  finishExecution,
  normalizeExecutionError,
  reportProgress,
} from "./active";
import type { ActiveExecution } from "./active";
import { responseContentLength } from "./common";

interface ManagedResponseStreamOptions {
  response: Response;
  execution: ActiveExecution;
  maximumBytes?: number;
  declaredBytes?: number;
  limitMessage: string;
  onFinalize?: (loadedBytes: number, completed: boolean) => void;
}

export interface ManagedResponseStream {
  stream: ReadableStream<Uint8Array>;
  declaredLength?: number;
}

function responseLimitError(message: string, cause?: unknown): Error {
  return cause === undefined
    ? new Error(message)
    : new Error(message, { cause });
}

export function createManagedResponseStream(
  options: ManagedResponseStreamOptions,
): ManagedResponseStream {
  const {
    response,
    execution,
    maximumBytes,
    declaredBytes,
    limitMessage,
    onFinalize,
  } = options;
  const headerBytes = responseContentLength(response);
  const declaredLength = declaredBytes ?? headerBytes;
  if (
    maximumBytes !== undefined &&
    ((headerBytes !== undefined && headerBytes > maximumBytes) ||
      (declaredLength !== undefined && declaredLength > maximumBytes))
  ) {
    execution.controller.abort("response-too-large");
    throw responseLimitError(limitMessage);
  }

  reportProgress(execution, "downloading", 0, declaredLength);
  const reader = response.body?.getReader();
  let loadedBytes = 0;
  let finalized = false;

  const finalize = (completed: boolean): void => {
    if (finalized) return;
    finalized = true;
    reader?.releaseLock();
    onFinalize?.(loadedBytes, completed);
    if (completed) {
      reportProgress(execution, "complete", loadedBytes, loadedBytes);
    }
    finishExecution(execution);
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (execution.controller.signal.aborted) {
        const error = normalizeExecutionError(
          execution,
          new DOMException("Request cancelled.", "AbortError"),
        );
        controller.error(error);
        finalize(false);
        return;
      }
      if (!reader) {
        finalize(true);
        controller.close();
        return;
      }

      try {
        const result = await reader.read();
        if (execution.controller.signal.aborted) {
          throw new DOMException("Request cancelled.", "AbortError");
        }
        if (result.done) {
          finalize(true);
          controller.close();
          return;
        }
        loadedBytes += result.value.byteLength;
        if (maximumBytes !== undefined && loadedBytes > maximumBytes) {
          await reader.cancel("response-too-large");
          execution.controller.abort("response-too-large");
          controller.error(responseLimitError(limitMessage));
          finalize(false);
          return;
        }
        controller.enqueue(result.value);
        reportProgress(execution, "downloading", loadedBytes, declaredLength);
      } catch (error) {
        let failure: unknown;
        if (
          !execution.controller.signal.aborted &&
          maximumBytes !== undefined &&
          loadedBytes >= maximumBytes
        ) {
          execution.controller.abort("response-too-large");
          failure = responseLimitError(limitMessage, error);
        } else {
          failure = normalizeExecutionError(execution, error);
        }
        controller.error(failure);
        finalize(false);
      }
    },
    async cancel(reason) {
      if (finalized) return;
      try {
        await reader?.cancel(reason);
      } finally {
        if (!execution.controller.signal.aborted) {
          execution.controller.abort("stream-cancelled");
        }
        finalize(false);
      }
    },
  });

  return {
    stream,
    ...(declaredLength === undefined ? {} : { declaredLength }),
  };
}
