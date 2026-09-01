import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("chrome", { i18n: { getUILanguage: () => "en-US" } });

describe("interface translations", () => {
  it("keeps English and Chinese message keys in sync", async () => {
    const { messages } = await import("../src/i18n");
    expect(Object.keys(messages["zh-CN"]).sort()).toEqual(
      Object.keys(messages["en-US"]).sort(),
    );
  });
});
