import { describe, expect, it, vi } from "vitest";

import { createDefaultRequest } from "@xpanel/contracts";

import { dispatchEnvelope } from "../src/lib/execution-messages";
import {
  hasBackgroundExecutionCapacity,
  MAX_CONCURRENT_EXECUTIONS,
} from "../src/lib/execution-background";
import {
  installOffscreenMessageListener,
  scopeExecutionFileReferences,
  type OffscreenExecutionCoordinator,
} from "../src/lib/execution-offscreen";

describe("offscreen startup race", () => {
  it("namespaces file references per execution", () => {
    const request = createDefaultRequest({
      body: {
        kind: "file",
        file: {
          id: "shared-file",
          name: "payload.bin",
          requiresReselection: false,
        },
      },
    });
    const first = scopeExecutionFileReferences(request, "execution-a");
    const second = scopeExecutionFileReferences(request, "execution-b");

    expect(first.body).toMatchObject({
      file: { id: "execution-a:shared-file" },
    });
    expect(second.body).toMatchObject({
      file: { id: "execution-b:shared-file" },
    });
  });

  it("enforces the four-execution global limit", () => {
    expect(MAX_CONCURRENT_EXECUTIONS).toBe(4);
    expect(hasBackgroundExecutionCapacity(3)).toBe(true);
    expect(hasBackgroundExecutionCapacity(4)).toBe(false);
  });

  it("registers immediately and gates start until orphan recovery finishes", async () => {
    let listener:
      | ((
          message: unknown,
          sender: chrome.runtime.MessageSender,
          sendResponse: (response: unknown) => void,
        ) => boolean)
      | undefined;
    vi.stubGlobal("chrome", {
      runtime: {
        id: "extension-id",
        onMessage: {
          addListener: vi.fn((value: NonNullable<typeof listener>) => {
            listener = value;
          }),
        },
      },
    });
    let finishInitialization!: () => void;
    const initialized = new Promise<void>((resolve) => {
      finishInitialization = resolve;
    });
    const start = vi.fn(async () => ({
      protocolVersion: 1 as const,
      commandId: "command-1",
      accepted: true,
    }));
    const coordinator = {
      start,
      cancel: vi.fn(),
    } as unknown as OffscreenExecutionCoordinator;

    installOffscreenMessageListener(coordinator, initialized);
    expect(listener).toBeTypeOf("function");
    const respond = vi.fn();
    const keepChannelOpen = listener!(
      dispatchEnvelope({
        protocolVersion: 1,
        commandId: "command-1",
        type: "execution.start",
        executionId: "execution-1",
        payloadHandle: "payload-1",
      }),
      { id: "extension-id" },
      respond,
    );
    expect(keepChannelOpen).toBe(true);
    expect(start).not.toHaveBeenCalled();

    finishInitialization();
    await initialized;
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({ accepted: true, commandId: "command-1" }),
      ),
    );
  });
});
