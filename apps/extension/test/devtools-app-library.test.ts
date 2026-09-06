import { flushPromises } from "@vue/test-utils";
import { createPinia } from "pinia";
import { describe, expect, it, vi } from "vitest";

import { createDefaultRequest, type CollectionRecord } from "@xpanel/contracts";

import { useWorkbenchStore } from "../src/stores/workbench";
import { database, mountApp } from "./devtools-app.harness";

vi.mock(
  "../src/lib/database",
  async () => (await import("./devtools-app.harness")).database,
);
vi.mock(
  "../src/lib/execute",
  async () => (await import("./devtools-app.harness")).execution,
);
vi.mock(
  "../src/lib/execution-client",
  async () => (await import("./devtools-app.harness")).backgroundExecution,
);
vi.mock(
  "../src/lib/remote-profiles",
  async () => (await import("./devtools-app.harness")).remoteProfiles,
);

describe("request importing", () => {
  it("closes a successful warning dialog and keeps the imported request selectable", async () => {
    const pinia = createPinia();
    const wrapper = await mountApp(pinia);
    const store = useWorkbenchStore(pinia);
    const openImport = wrapper
      .findAll("button")
      .find((button) => button.text().trim() === "Import");
    if (!openImport) throw new Error("Expected the Import button.");
    await openImport.trigger("click");
    const dialog = wrapper.get('[aria-label="Import requests"]');
    await dialog
      .get("textarea.dialog-editor")
      .setValue("curl 'https://api.example.com' --max-time 0");

    await dialog.get("button.primary-button").trigger("click");
    await flushPromises();

    expect(wrapper.find('[aria-label="Import requests"]').exists()).toBe(false);
    expect(wrapper.text()).toContain(
      "Imported with 1 warning(s). Reopen Import to review them.",
    );
    const loadRequest = vi.spyOn(store, "loadRequest");
    const imported = wrapper
      .findAll("button.request-link")
      .find((button) => button.text().includes("Imported cURL 1"));
    if (!imported)
      throw new Error("Expected the imported request in the sidebar.");

    await imported.trigger("click");

    expect(loadRequest).toHaveBeenCalledOnce();
    expect(store.current.name).toBe("Imported cURL 1");
    wrapper.unmount();
  });
});

describe("saved item deletion", () => {
  const importedRequest = createDefaultRequest({
    id: "request-imported",
    name: "Imported cURL 1",
    method: "POST",
    favorite: true,
  });
  const importedCollection: CollectionRecord = {
    id: "collection-imported",
    name: "Imported 9/2/2026, 10:51:11 AM",
    description: "Imported collection",
    requestIds: [importedRequest.id],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it("opens an accessible request confirmation without loading the row", async () => {
    database.loadWorkspace.mockResolvedValueOnce({
      collections: [importedCollection],
      requests: [importedRequest],
      warnings: [],
    });
    const pinia = createPinia();
    const wrapper = await mountApp(pinia);
    const store = useWorkbenchStore(pinia);
    const loadRequest = vi.spyOn(store, "loadRequest");
    const deleteRequest = vi
      .spyOn(store, "deleteRequest")
      .mockResolvedValue(undefined);
    const focus = vi.spyOn(HTMLButtonElement.prototype, "focus");

    const deleteButtons = wrapper.findAll(
      'button[aria-label="Delete request: Imported cURL 1"]',
    );
    expect(deleteButtons).toHaveLength(2);
    await deleteButtons[0]?.trigger("click");

    expect(loadRequest).not.toHaveBeenCalled();
    const dialog = wrapper.get('[role="alertdialog"]');
    expect(dialog.attributes("aria-modal")).toBe("true");
    expect(dialog.text()).toContain("Delete request?");
    expect(dialog.text()).toContain("every collection and Favorites");
    expect(dialog.text()).toContain("This action cannot be undone.");
    expect(wrapper.get("aside.sidebar").attributes()).not.toHaveProperty(
      "inert",
    );
    expect(wrapper.get("aside.sidebar").attributes()).not.toHaveProperty(
      "aria-hidden",
    );
    expect(dialog.attributes()).toHaveProperty("open");
    const cancel = dialog.get("button.ghost-button");
    expect(focus.mock.instances).toContain(cancel.element);

    await cancel.trigger("click");
    await flushPromises();

    expect(deleteRequest).not.toHaveBeenCalled();
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false);

    await deleteButtons[0]?.trigger("click");
    const reopenedDialog = wrapper.get('[role="alertdialog"]');
    const confirm = reopenedDialog.get("button.danger-button");
    store.busy = true;
    await wrapper.vm.$nextTick();
    expect(confirm.attributes()).toHaveProperty("disabled");
    await confirm.trigger("click");
    expect(deleteRequest).not.toHaveBeenCalled();

    store.busy = false;
    await wrapper.vm.$nextTick();
    await confirm.trigger("click");
    await flushPromises();

    expect(deleteRequest).toHaveBeenCalledWith(importedRequest.id);
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("keeps collection requests by default and passes a non-cascade delete", async () => {
    database.loadWorkspace.mockResolvedValueOnce({
      collections: [importedCollection],
      requests: [importedRequest],
      warnings: [],
    });
    const pinia = createPinia();
    const wrapper = await mountApp(pinia);
    const store = useWorkbenchStore(pinia);
    const deleteCollection = vi
      .spyOn(store, "deleteCollection")
      .mockResolvedValue(undefined);

    await wrapper
      .get(
        'button[aria-label="Delete collection: Imported 9/2/2026, 10:51:11 AM"]',
      )
      .trigger("click");

    const dialog = wrapper.get('[role="alertdialog"]');
    const cascade = dialog.get('input[type="checkbox"]');
    expect((cascade.element as HTMLInputElement).checked).toBe(false);
    expect(dialog.text()).toContain("move to My requests");

    await dialog.get("button.danger-button").trigger("click");
    await flushPromises();

    expect(deleteCollection).toHaveBeenCalledWith(importedCollection.id, false);
    wrapper.unmount();
  });

  it("shows exclusive/shared impact before a collection cascade delete", async () => {
    const sharedRequest = createDefaultRequest({
      id: "request-shared",
      name: "Shared request",
    });
    const targetCollection = {
      ...importedCollection,
      requestIds: [importedRequest.id, sharedRequest.id],
    };
    const otherCollection: CollectionRecord = {
      id: "collection-other",
      name: "Other collection",
      description: "",
      requestIds: [sharedRequest.id],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    database.loadWorkspace.mockResolvedValueOnce({
      collections: [targetCollection, otherCollection],
      requests: [importedRequest, sharedRequest],
      warnings: [],
    });
    const pinia = createPinia();
    const wrapper = await mountApp(pinia);
    const store = useWorkbenchStore(pinia);
    const deleteCollection = vi
      .spyOn(store, "deleteCollection")
      .mockResolvedValue(undefined);

    await wrapper
      .get(
        'button[aria-label="Delete collection: Imported 9/2/2026, 10:51:11 AM"]',
      )
      .trigger("click");
    const dialog = wrapper.get('[role="alertdialog"]');
    const cascade = dialog.get('input[type="checkbox"]');
    expect(dialog.get(".cascade-delete").text()).toContain("(1)");

    await cascade.setValue(true);
    expect(dialog.text()).toContain(
      "Exclusive requests permanently deleted and removed from Favorites: 1.",
    );
    expect(dialog.text()).toContain(
      "Shared requests kept in their other collections: 1.",
    );
    await dialog.get("button.danger-button").trigger("click");
    await flushPromises();

    expect(deleteCollection).toHaveBeenCalledWith(targetCollection.id, true);
    wrapper.unmount();
  });
});
