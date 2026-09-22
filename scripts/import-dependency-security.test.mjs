import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { test } from "node:test";

const extension = createRequire(
  new URL("../apps/extension/package.json", import.meta.url),
);

// Keep adversarial parsers in a bounded child process: a dependency regression
// must fail CI, not hang the test runner. All data is generated synthetic input.
function boundedProbe(source) {
  return execFileSync(
    process.execPath,
    ["--input-type=commonjs", "-e", source],
    {
      timeout: 5_000,
      encoding: "utf8",
      windowsHide: true,
    },
  ).trim();
}

test("YAML nesting is rejected as a parse error rather than stack overflow", () => {
  // GHSA-48c2-rrv3-qjmp
  const result = boundedProbe(`
    const {parse} = require(${JSON.stringify(extension.resolve("yaml"))});
    try { parse('['.repeat(5000) + '1' + ']'.repeat(5000)); }
    catch (error) { process.stdout.write(error.name); }
  `);
  assert.equal(result, "YAMLParseError");
});

test("malformed ZIP64 missing its extra field fails without hanging", () => {
  // GHSA-px8p-9vwx-vf98
  const result = boundedProbe(`
    const {zipSync, unzipSync} = require(${JSON.stringify(extension.resolve("fflate"))});
    const original = Buffer.from(zipSync({fixture: new Uint8Array([1,2,3])}));
    const end = original.length - 22;
    const zip64 = Buffer.alloc(56);
    zip64.writeUInt32LE(0x06064b50, 0);
    zip64.writeBigUInt64LE(44n, 4);
    zip64.writeBigUInt64LE(1n, 24);
    zip64.writeBigUInt64LE(1n, 32);
    zip64.writeBigUInt64LE(BigInt(original.readUInt32LE(end + 12)), 40);
    zip64.writeBigUInt64LE(BigInt(original.readUInt32LE(end + 16)), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(end), 8);
    const zip = Buffer.concat([original.subarray(0, end), zip64, locator, original.subarray(end)]);
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    if (central < 0) throw new Error('Missing central directory');
    zip.writeUInt32LE(0xffffffff, central + 20);
    zip.writeUInt32LE(0xffffffff, central + 24);
    try { unzipSync(zip); } catch { process.stdout.write('rejected'); }
  `);
  assert.equal(result, "rejected");
});
