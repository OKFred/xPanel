import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, ref } from "vue";
import { describe, expect, it } from "vitest";

import HttpMethodCombobox from "../src/components/HttpMethodCombobox.vue";
import AppDialog from "../src/components/dialog/AppDialog.vue";
import ImportRequestsDialog from "../src/components/dialog/ImportRequestsDialog.vue";

describe("HTTP method combobox", () => {
  it("opens a real option list while retaining custom method input", async () => {
    const wrapper = mount(HttpMethodCombobox, {
      props: {
        modelValue: "GET",
        label: "HTTP method",
        invalidMessage: "Invalid method",
      },
    });
    const input = wrapper.get("input[role='combobox']");
    await input.trigger("focus");
    expect(input.attributes("aria-expanded")).toBe("true");
    expect(wrapper.findAll("[role='option']")).toHaveLength(7);

    await wrapper.findAll("[role='option']")[1]!.trigger("mousedown");
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual(["POST"]);

    await wrapper.setProps({ modelValue: "GET" });
    await input.setValue("propfind");
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual(["PROPFIND"]);
    await wrapper.setProps({ modelValue: "PROPFIND" });
    expect(input.attributes("aria-invalid")).toBeUndefined();
  });

  it("reports invalid custom tokens without discarding the typed value", async () => {
    const wrapper = mount(HttpMethodCombobox, {
      props: {
        modelValue: "BAD METHOD",
        label: "HTTP method",
        invalidMessage: "Invalid method",
      },
    });
    expect(wrapper.get("input").attributes("aria-invalid")).toBe("true");
    expect(wrapper.get("[role='alert']").text()).toBe("Invalid method");
  });

  it("supports arrow navigation, Enter selection, and Escape dismissal", async () => {
    const wrapper = mount(HttpMethodCombobox, {
      props: {
        modelValue: "GET",
        label: "HTTP method",
        invalidMessage: "Invalid method",
      },
    });
    const input = wrapper.get("input[role='combobox']");
    expect(input.attributes("aria-autocomplete")).toBe("list");

    await input.trigger("keydown", { key: "ArrowDown" });
    await input.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual(["POST"]);
    expect(input.attributes("aria-expanded")).toBe("false");

    await input.trigger("focus");
    await input.trigger("keydown", { key: "Escape" });
    expect(input.attributes("aria-expanded")).toBe("false");
  });
});

describe("native application dialog", () => {
  it("focuses inside, contains Tab, closes with Escape, and restores focus", async () => {
    const Host = defineComponent({
      components: { AppDialog },
      setup() {
        const open = ref(false);
        return { open };
      },
      template: `
        <button class="trigger" @click="open = true">Open</button>
        <AppDialog
          v-if="open"
          labelled-by="test-title"
          @close="open = false"
        >
          <h2 id="test-title">Dialog</h2>
          <button class="first" data-dialog-initial-focus>First</button>
          <button class="last">Last</button>
        </AppDialog>
      `,
    });
    const wrapper = mount(Host, { attachTo: document.body });
    const trigger = wrapper.get<HTMLButtonElement>("button.trigger");
    trigger.element.focus();
    await trigger.trigger("click");
    await flushPromises();
    const dialog = wrapper.get("dialog[open]");
    expect(wrapper.find("[aria-hidden='true']").exists()).toBe(false);
    const first = wrapper.get<HTMLButtonElement>("button.first");
    const last = wrapper.get<HTMLButtonElement>("button.last");
    expect(document.activeElement).toBe(first.element);

    last.element.focus();
    await dialog.trigger("keydown", { key: "Tab" });
    expect(document.activeElement).toBe(first.element);

    await dialog.trigger("cancel");
    await flushPromises();
    expect(wrapper.find("dialog").exists()).toBe(false);
    expect(document.activeElement).toBe(trigger.element);
    wrapper.unmount();
  });
});

describe("standalone import capability", () => {
  it("explains that Current Network HAR remains DevTools-only", () => {
    const wrapper = mount(ImportRequestsDialog, {
      props: {
        text: "",
        detectedFormat: "unknown",
        warnings: [],
        canImportCurrentHar: false,
      },
      global: { mocks: { $t: (key: string) => key } },
    });
    const har = wrapper
      .findAll("button")
      .find((button) => button.text().includes("currentHar"));
    expect(har?.attributes()).toHaveProperty("disabled");
    expect(wrapper.text()).toContain("currentHarDevtoolsOnly");
  });
});
