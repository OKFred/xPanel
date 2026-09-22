import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { invariant } from "./utils.mjs";

/** Only the synthetic target differs; the released Gateway remains immutable. */
export async function fixtureDeploymentRunner(root, directory, runWrangler) {
  const config = join(directory, "wrangler.fixture.jsonc");
  await writeFile(
    config,
    JSON.stringify({
      main: join(import.meta.dirname, "cloudflare-target.worker.mjs"),
      alias: {
        "@one-fetch/conformance": join(
          root,
          "packages/conformance/dist/index.js",
        ),
      },
      compatibility_date: "2026-09-04",
      compatibility_flags: ["enable_request_signal"],
      workers_dev: true,
      observability: { enabled: false },
      logpush: false,
      tail_consumers: [],
    }),
  );
  return (args) => {
    invariant(
      args[0] === "deploy" && args.includes("--config"),
      "Unexpected fixture operation.",
    );
    const next = [...args];
    next[next.indexOf("--config") + 1] = config;
    return runWrangler(next);
  };
}

/** Fail before UI acceptance if the platform cannot produce a real truncation. */
export async function verifyTruncatedFixture(origin, read = fetch) {
  const response = await read(`${origin}/truncated-fixed`, {
    cache: "no-store",
    redirect: "error",
    signal: globalThis.AbortSignal.timeout(10_000),
  });
  invariant(
    response.status === 200 && response.headers.get("content-length") === "14",
    "Synthetic truncation did not preserve its advertised length.",
  );
  let failed = false;
  try {
    await response.arrayBuffer();
  } catch (error) {
    failed = error instanceof TypeError;
  }
  invariant(
    failed,
    "Synthetic truncated response completed instead of failing.",
  );
}
