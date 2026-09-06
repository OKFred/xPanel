import { afterEach, describe, expect, it, vi } from "vitest";

import {
  executionPermissionQuerySchema,
  hasExecutionOriginPermission,
  installExecutionPermissionBridge,
} from "../src/lib/execution-permission-bridge";

afterEach(() => vi.unstubAllGlobals());

describe("execution permission bridge", () => {
  it("strictly validates same-extension redirect permission queries", async () => {
    let listener:
      | ((
          message: unknown,
          sender: chrome.runtime.MessageSender,
          sendResponse: (response: unknown) => void,
        ) => boolean)
      | undefined;
    const contains = vi.fn(async () => true);
    vi.stubGlobal("chrome", {
      permissions: { contains },
      runtime: {
        id: "extension-id",
        onMessage: {
          addListener: vi.fn((value: NonNullable<typeof listener>) => {
            listener = value;
          }),
        },
      },
    });
    installExecutionPermissionBridge();

    const query = executionPermissionQuerySchema.parse({
      channel: "xpanel.execution.permission.v1",
      recipient: "background",
      commandId: crypto.randomUUID(),
      origin: "https://redirected.example.test",
    });
    const respond = vi.fn();
    expect(listener?.(query, { id: "another-extension" }, respond)).toBe(false);
    expect(
      listener?.(
        { ...query, unexpected: true },
        { id: "extension-id" },
        respond,
      ),
    ).toBe(false);
    expect(listener?.(query, { id: "extension-id" }, respond)).toBe(true);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(respond).toHaveBeenCalledWith({
      channel: "xpanel.execution.permission.v1",
      commandId: query.commandId,
      granted: true,
    });
    expect(contains).toHaveBeenCalledWith({
      origins: ["https://redirected.example.test/*"],
    });
  });

  it("uses a validated runtime round-trip when permissions is unavailable", async () => {
    const sendMessage = vi.fn(async (message: { commandId: string }) => ({
      channel: "xpanel.execution.permission.v1",
      commandId: message.commandId,
      granted: true,
    }));
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    await expect(
      hasExecutionOriginPermission("https://redirected.example.test"),
    ).resolves.toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
