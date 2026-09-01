import { describe, expect, it } from "vitest";
import { ManagedProcess } from "../src/runner.js";

describe("managed process cancellation", () => {
  it("terminates a running child and reports cancellation", async () => {
    const processHandle = new ManagedProcess(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
    ]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(processHandle.cancel()).toBe(true);
    const result = await processHandle.completion;
    expect(result.cancelled).toBe(true);
    expect(result.exitCode === null || result.exitCode !== 0).toBe(true);
  });
});
