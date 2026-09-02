import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const testTokenDigest =
  "8ac5ac04b5072d24a84208c4672a3adac06fcdec6dbdf057552c2c2607029438";
process.env.RELAY_TOKEN_SHA256 ??= testTokenDigest;

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
      miniflare: {
        // @cloudflare/vitest-pool-workers 0.22.0 currently bundles a workerd
        // release whose newest supported date is 2026-08-22. Keep the
        // production Worker pinned to 2026-09-02 in wrangler.jsonc and scope
        // this compatibility override to the test runtime only.
        compatibilityDate: "2026-08-22",
        bindings: {
          TARGET_POLICY: "allowlist",
          ALLOWED_TARGET_ORIGINS: "https://api.example.com",
          // SHA-256("test-relay-token")
          RELAY_TOKEN_SHA256: testTokenDigest,
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
