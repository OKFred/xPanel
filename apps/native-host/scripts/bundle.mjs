import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const outputDirectory = path.join(packageRoot, "dist");

await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [path.join(packageRoot, "src/index.ts")],
  outfile: path.join(outputDirectory, "sea.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node24",
  sourcemap: false,
  minify: false,
  legalComments: "none",
});
