// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import KeyValueEditor from "../src/components/KeyValueEditor.vue";

describe("KeyValueEditor", () => {
  it("adds and removes entries without mutating the prop", async () => {
    const original = [
      { name: "Accept", value: "application/json", enabled: true },
    ];
    const wrapper = mount(KeyValueEditor, { props: { modelValue: original } });

    await wrapper.get("button.add-row").trigger("click");
    const additions = wrapper.emitted("update:modelValue");
    expect(additions?.[0]?.[0]).toHaveLength(2);
    expect(original).toHaveLength(1);

    await wrapper.findAll('button[aria-label="Remove"]')[0]?.trigger("click");
    const removals = wrapper.emitted("update:modelValue");
    expect(removals?.at(-1)?.[0]).toEqual([]);
  });

  it("lets custom credentials be explicitly marked sensitive", async () => {
    const wrapper = mount(KeyValueEditor, {
      props: {
        modelValue: [{ name: "X-Signature", value: "secret", enabled: true }],
      },
    });
    await wrapper
      .get('input[aria-label="Sensitive X-Signature"]')
      .setValue(true);
    expect(wrapper.emitted("update:modelValue")?.at(-1)?.[0]).toEqual([
      { name: "X-Signature", value: "secret", enabled: true, sensitive: true },
    ]);
  });
});
