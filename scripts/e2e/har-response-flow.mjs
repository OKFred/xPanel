import { clickTextScript, setInput } from "./panel-actions.mjs";
import { invariant, waitFor } from "./utils.mjs";

export async function runHarResponseFlow(panel) {
  const contents = Array.from({ length: 14 }, (_, index) => {
    if (index === 0) return { size: 318_000 };
    if (index === 1) return { size: 1, text: "中文🙂" };
    if (index === 2) return { text: "AP8BAg==", encoding: "base64" };
    if (index === 3) return { size: 30, text: "!invalid!", encoding: "base64" };
    return { size: 100, text: `captured-${index}` };
  });
  const har = {
    log: {
      version: "1.2",
      entries: contents.map((content, index) => ({
        request: {
          method: "GET",
          url: `https://har-storage.example.invalid/${index}`,
        },
        response: { status: 200, statusText: "OK", content },
      })),
    },
  };
  await panel.evaluate(clickTextScript("Import"), { userGesture: true });
  await setInput(
    panel,
    '[aria-label="Import requests"] textarea',
    JSON.stringify(har),
  );
  await panel.evaluate(
    clickTextScript(
      "Import",
      `document.querySelector('[aria-label="Import requests"]')`,
    ),
    { userGesture: true },
  );
  await waitFor(
    () =>
      panel.evaluate(
        `!document.querySelector('dialog[aria-label="Import requests"]')`,
      ),
    "14 HAR responses imported",
  );
  invariant(
    await panel.evaluate(
      `!document.querySelector('.workspace [data-error="true"]')`,
    ),
    "Mixed HAR import raised an error.",
  );
  // Read only this synthetic test collection from the actual extension database.
  const captured = await panel.evaluate(`(async () => {
    const db = await new Promise((resolve, reject) => {
      const open = indexedDB.open('xpanel');
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const all = (store) => new Promise((resolve, reject) => {
      const get = db.transaction(store).objectStore(store).getAll();
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error);
    });
    try {
      const requests = (await all('requests')).filter(item => item.url.startsWith('https://har-storage.example.invalid/'));
      const ids = new Set(requests.map(item => item.id));
      const responses = (await all('execution-responses')).filter(item => ids.has(item.requestId));
      const bodies = new Map((await all('execution-bodies')).map(item => [item.handle, item]));
      return { requests: requests.length, responses: responses.length,
        consistent: responses.every(item => bodies.get(item.handle)?.blob.size === item.body.sizeBytes),
        sizes: responses.map(item => item.body.sizeBytes),
        missing: responses.some(item => item.body.sizeBytes === 0 && item.warnings.some(w => w.code === 'har.response_body_missing')) };
    } finally { db.close(); }
  })()`);
  invariant(
    captured.requests === 14 && captured.responses === 14,
    "HAR import did not persist all 14 requests and responses.",
  );
  invariant(
    captured.consistent &&
      captured.missing &&
      captured.sizes.includes(10) &&
      captured.sizes.includes(4),
    "HAR stored bytes or missing-body warnings were incorrect.",
  );
}
