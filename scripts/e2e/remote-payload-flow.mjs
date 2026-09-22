import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { clickTextScript, setInput } from "./panel-actions.mjs";
import { send, settle, result } from "./remote-result-checks.mjs";
import { invariant, waitFor } from "./utils.mjs";

const requestScope = "document.querySelector('.request-pane')";

async function bodyKind(panel, kind) {
  await panel.evaluate(clickTextScript("Body", requestScope));
  await panel.evaluate(`(() => {
    const select = document.querySelector('.body-editor select');
    select.value = ${JSON.stringify(kind)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
}

async function chooseFile(panel, selector, path) {
  const { root } = await panel.send("DOM.getDocument");
  const { nodeId } = await panel.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector,
  });
  invariant(nodeId, "File chooser is not present.");
  await panel.send("DOM.setFileInputFiles", { nodeId, files: [path] });
  await waitFor(
    () =>
      panel.evaluate(
        `document.querySelector(${JSON.stringify(selector)})?.files?.length === 1`,
      ),
    "user-selected synthetic file",
  );
}

async function echo(panel, url) {
  await send(panel, url);
  await settle(
    panel,
    (s) =>
      s.source === "target" &&
      /Body integrity\s*:\s*Verified\b/u.test(s.detail),
    "upload response integrity",
  );
  await panel.evaluate(
    clickTextScript("Raw", "document.querySelector('.response-tabs')"),
  );
  return waitFor(async () => {
    const text = await panel.evaluate(
      "document.querySelector('.response-document-viewer')?.innerText",
    );
    try {
      const value = JSON.parse(text);
      return typeof value.bodyBase64 === "string" ? value : undefined;
    } catch {
      return undefined;
    }
  }, "synthetic target echo");
}

/** Real workbench fields and native file input; no store/SDK injection. */
export async function runRemotePayloadFlow(panel, origin, cloud) {
  const directory = await mkdtemp(join(tmpdir(), "xpanel-payload-e2e-"));
  const file = join(directory, "synthetic.bin");
  const bytes = Buffer.from([0, 1, 2, 13, 10, 127, 128, 254, 255]);
  await writeFile(file, bytes);
  const url = `${origin}/${cloud ? "v1/" : ""}echo?duplicate=one&duplicate=two&encoded=a%2Bb`;
  try {
    await setInput(panel, ".method-select", "POST");
    await bodyKind(panel, "json");
    const json = '{"synthetic":"xpanel-你好","count":2}';
    await setInput(panel, ".body-editor textarea", json);
    let value = await echo(panel, url);
    invariant(
      value.method === "POST" &&
        Buffer.from(value.bodyBase64, "base64").toString() === json,
      "JSON upload changed bytes.",
    );
    invariant(
      (value.rawQuery ?? value.path).includes(
        "duplicate=one&duplicate=two&encoded=a%2Bb",
      ),
      "Repeated/encoded query changed.",
    );

    await bodyKind(panel, "file");
    await chooseFile(panel, ".raw-file-option input[type=file]", file);
    await setInput(
      panel,
      ".raw-file-option input.field",
      "application/octet-stream",
    );
    value = await echo(panel, url);
    invariant(
      Buffer.from(value.bodyBase64, "base64").equals(bytes),
      "Binary upload changed bytes.",
    );

    await bodyKind(panel, "multipart");
    await panel.evaluate(clickTextScript("Text field", requestScope));
    await setInput(
      panel,
      '.multipart-row input[placeholder="Field name"]',
      "description",
    );
    await setInput(
      panel,
      '.multipart-row input[placeholder="Value"]',
      "synthetic-你好",
    );
    await panel.evaluate(clickTextScript("File", requestScope));
    await chooseFile(panel, ".multipart-row input[type=file]", file);
    value = await echo(panel, url);
    const multipart = Buffer.from(value.bodyBase64, "base64");
    const boundary = /boundary=(.+)$/u.exec(value.contentType)?.[1];
    invariant(
      boundary &&
        multipart.includes(`--${boundary}\r\n`) &&
        multipart.includes(`--${boundary}--`),
      "Multipart boundary was lost.",
    );
    invariant(
      multipart.includes('name="description"') &&
        multipart.includes("synthetic-你好") &&
        multipart.includes('filename="synthetic.bin"') &&
        multipart.includes(bytes),
      "Multipart text/file changed.",
    );

    await bodyKind(panel, "none");
    await setInput(panel, ".method-select", "GET");
    await panel.evaluate(clickTextScript("Options", requestScope));
    await setInput(panel, ".options-grid input[type=number]", "1");
    const previous = await result(panel);
    await send(panel, `${origin}/${cloud ? "delay/12000" : "slow"}`);
    await settle(
      panel,
      (s) => /timed out|timeout/iu.test(s.error),
      "Remote timeout",
    );
    invariant(
      (await result(panel)).meta === previous.meta,
      "Timeout replaced the last successful response.",
    );
    await setInput(panel, ".options-grid input[type=number]", "60");
    process.stdout.write(
      "Remote payload UI passed: POST JSON, repeated/encoded query, selected binary file, multipart text/file, timeout preserves last result.\n",
    );
  } finally {
    invariant(
      dirname(resolve(directory)) === resolve(tmpdir()) &&
        basename(directory).startsWith("xpanel-payload-e2e-"),
      "Unexpected fixture directory.",
    );
    await rm(directory, { recursive: true });
  }
}
