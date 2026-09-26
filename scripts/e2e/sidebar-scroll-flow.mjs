import { createDefaultRequest } from "../../packages/contracts/dist/index.js";
import { clickTextScript, setInput } from "./panel-actions.mjs";
import { invariant, waitFor } from "./utils.mjs";

export async function seedSidebarScrollFixture(panel) {
  const timestamp = new Date(0).toISOString();
  const requests = Array.from({ length: 80 }, (_, index) =>
    createDefaultRequest({
      id: `sidebar-${index}`,
      name: `Sidebar fixture ${index}`,
      favorite: index >= 60,
      url: `https://sidebar.example.invalid/${index}`,
    }),
  );
  const collections = Array.from({ length: 10 }, (_, index) => ({
    id: `sidebar-collection-${index}`,
    name: `Sidebar collection ${index}`,
    description: "Synthetic scrolling fixture",
    createdAt: timestamp,
    updatedAt: timestamp,
    requestIds: requests.slice(index * 8, index * 8 + 8).map((item) => item.id),
  }));
  await panel.evaluate(clickTextScript("Import"), { userGesture: true });
  await setInput(
    panel,
    '[aria-label="Import requests"] textarea',
    JSON.stringify({
      schemaVersion: 1,
      exportedAt: timestamp,
      collections,
      requests,
    }),
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
    "sidebar fixture imported",
  );
}

async function snapshot(panel, selector) {
  return panel.evaluate(`(() => {
    const section = document.querySelector(${JSON.stringify(selector)});
    const rect = section.getBoundingClientRect();
    const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
    const footer = document.querySelector('.sidebar-footer').getBoundingClientRect();
    const brand = document.querySelector('.brand-row').getBoundingClientRect();
    return { clientHeight: section.clientHeight, scrollHeight: section.scrollHeight,
      top: section.scrollTop, overflow: getComputedStyle(section).overflowY,
      x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
      fits: sidebar.bottom <= innerHeight + 1 && brand.top >= 0 && footer.bottom <= innerHeight + 1,
      footerTop: footer.top };
  })()`);
}

export async function verifySidebarScroll(panel, surface, wheel = false) {
  for (const selector of [
    ".sidebar-section:not(.favorites)",
    ".sidebar-section.favorites",
  ]) {
    await panel.evaluate(
      `document.querySelector(${JSON.stringify(selector)}).scrollTop = 0`,
    );
    const before = await snapshot(panel, selector);
    invariant(
      before.fits &&
        before.clientHeight > 30 &&
        before.scrollHeight > before.clientHeight &&
        before.overflow === "auto",
      `${surface} sidebar is not bounded/scrollable: ${JSON.stringify(before)}`,
    );
    if (wheel) {
      await panel.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: before.x,
        y: before.y,
        deltaX: 0,
        deltaY: 240,
      });
    } else {
      await panel.evaluate(
        `document.querySelector(${JSON.stringify(selector)}).scrollBy(0, 240)`,
      );
    }
    await waitFor(
      async () => (await snapshot(panel, selector)).top > 0,
      `${surface} sidebar scroll movement`,
    );
    // Keyboard focus must also reveal the final request without moving the footer.
    await panel.evaluate(`(() => {
      const section = document.querySelector(${JSON.stringify(selector)});
      section.scrollTop = 0;
      [...section.querySelectorAll('.request-link')].find(button => button.textContent.includes('Sidebar fixture 79')).focus();
    })()`);
    const after = await snapshot(panel, selector);
    invariant(
      after.top > 0 &&
        after.fits &&
        Math.abs(after.footerTop - before.footerTop) < 1,
      `${surface} focus scrolling displaced the sidebar footer.`,
    );
    const lastVisible = await panel.evaluate(`(() => {
      const section = document.querySelector(${JSON.stringify(selector)});
      const button = [...section.querySelectorAll('.request-link')].find(button => button.textContent.includes('Sidebar fixture 79'));
      const row = button.getBoundingClientRect();
      const bounds = section.getBoundingClientRect();
      if (row.top < bounds.top || row.bottom > bounds.bottom + 1) return false;
      button.click(); return true;
    })()`);
    invariant(lastVisible, `${surface} last request remains clipped.`);
    await waitFor(
      () =>
        panel.evaluate(
          `document.querySelector('.url-input')?.value === 'https://sidebar.example.invalid/79'`,
        ),
      `${surface} last sidebar request selected`,
    );
  }
  // Do not let later background fixtures edit the selected saved test request.
  await panel.evaluate(clickTextScript("New request"), { userGesture: true });
  console.log(
    `Chromium ${surface} sidebar scroll passed: collections, favorites, last selection and fixed footer.`,
  );
}
