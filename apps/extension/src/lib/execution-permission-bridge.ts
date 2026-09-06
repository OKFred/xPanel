import { z } from "zod";

const channel = z.literal("xpanel.execution.permission.v1");
const httpOriginSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin === value
    );
  }, "Expected a canonical HTTP or HTTPS origin");

export const executionPermissionQuerySchema = z
  .object({
    channel,
    recipient: z.literal("background"),
    commandId: z.string().uuid(),
    origin: httpOriginSchema,
  })
  .strict();

export const executionPermissionResultSchema = z
  .object({
    channel,
    commandId: z.string().uuid(),
    granted: z.boolean(),
  })
  .strict();

export async function hasExecutionOriginPermission(
  origin: string,
): Promise<boolean> {
  const validatedOrigin = httpOriginSchema.parse(origin);
  if (typeof chrome.permissions?.contains === "function") {
    return chrome.permissions.contains({ origins: [`${validatedOrigin}/*`] });
  }

  const commandId = crypto.randomUUID();
  const raw: unknown = await chrome.runtime.sendMessage(
    executionPermissionQuerySchema.parse({
      channel: "xpanel.execution.permission.v1",
      recipient: "background",
      commandId,
      origin: validatedOrigin,
    }),
  );
  const result = executionPermissionResultSchema.parse(raw);
  if (result.commandId !== commandId) {
    throw new Error("Background permission response did not match its query.");
  }
  return result.granted;
}

export function installExecutionPermissionBridge(): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    const parsed = executionPermissionQuerySchema.safeParse(message);
    if (!parsed.success) return false;
    const { commandId, origin } = parsed.data;
    void chrome.permissions
      .contains({ origins: [`${origin}/*`] })
      .then((granted) =>
        sendResponse(
          executionPermissionResultSchema.parse({
            channel: "xpanel.execution.permission.v1",
            commandId,
            granted,
          }),
        ),
      )
      .catch(() =>
        sendResponse(
          executionPermissionResultSchema.parse({
            channel: "xpanel.execution.permission.v1",
            commandId,
            granted: false,
          }),
        ),
      );
    return true;
  });
}
