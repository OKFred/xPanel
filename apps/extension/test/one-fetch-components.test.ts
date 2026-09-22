import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { UserDenyRulesV1Schema } from "@one-fetch/protocol";
import type { OneFetchResponseDetailsV1 } from "@xpanel/contracts";
import UserDenyRulesEditor from "../src/components/one-fetch/UserDenyRulesEditor.vue";
import OneFetchResponseDetails from "../src/components/one-fetch/OneFetchResponseDetails.vue";
import OneFetchCapabilities from "../src/components/one-fetch/OneFetchCapabilities.vue";
import { capabilities } from "./one-fetch.fixture";
const global = { mocks: { $t: (key: string) => key } };

describe("one-fetch disclosures and deny-rule editor", () => {
  it("offers an inactive example and toggles only deny rules", async () => {
    const wrapper = mount(UserDenyRulesEditor, { props: { modelValue: '{"schemaVersion":1,"rules":[]}', disabled: false }, global });
    await wrapper.find("button").trigger("click");
    const example = wrapper.emitted("update:modelValue")?.[0]?.[0] as string;
    expect(UserDenyRulesV1Schema.parse(JSON.parse(example)).rules[0]).toMatchObject({ action: "deny", enabled: false });
    await wrapper.setProps({ modelValue: example });
    await wrapper.find("input[type=checkbox]").setValue(true);
    const toggled = wrapper.emitted("update:modelValue")?.at(-1)?.[0] as string;
    expect(UserDenyRulesV1Schema.parse(JSON.parse(toggled)).rules[0]?.enabled).toBe(true);
    expect(wrapper.find("button").attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });
  it("locates invalid rules and refuses administrator allow actions", async () => {
    const wrapper = mount(UserDenyRulesEditor, { props: { modelValue: '{"schemaVersion":1,"rules":[{"id":"a","name":"Allow","enabled":true,"action":"allow","match":{}}]}', disabled: false }, global });
    expect(wrapper.find('[role="alert"]').text()).toContain("rules.0.action");
    await wrapper.setProps({ modelValue: "{bad" });
    expect(wrapper.find('[role="alert"]').text()).toContain("Invalid JSON");
    wrapper.unmount();
  });
  it("does not claim verified body integrity just because target metadata is signed", () => {
    const details: OneFetchResponseDetailsV1 = { schemaVersion: 1, source: "target", outerStatus: 503, outerHeaders: [], mutations: [], audit: "unknown", integrity: "unverified" };
    const wrapper = mount(OneFetchResponseDetails, { props: { details, tab: "timing" }, global });
    expect(wrapper.text()).toContain("oneFetchUnverified");
    expect(wrapper.text()).not.toContain("oneFetchVerified");
    for (const phase of ["dns", "tcp", "tls", "ttfb", "download"]) expect(wrapper.text()).toContain(`gateway / ${phase}: oneFetchUnavailable`);
    wrapper.unmount();
  });
  it("shows intermediary diagnostics and outer headers as text, never executable HTML", () => {
    const details: OneFetchResponseDetailsV1 = { schemaVersion: 1, source: "intermediary", outerStatus: 200,
      outerHeaders: [{ name: "Server", value: "<script>unsafe()</script>" }], mutations: [], audit: "unknown", integrity: "unverified", reason: "missing-metadata" };
    const wrapper = mount(OneFetchResponseDetails, { props: { details, tab: "headers" }, global });
    expect(wrapper.attributes("data-source")).toBe("intermediary");
    expect(wrapper.text()).toContain("oneFetchIntermediary");
    expect(wrapper.text()).toContain("<script>unsafe()</script>");
    expect(wrapper.find("script").exists()).toBe(false);
    wrapper.unmount();
  });
  it("shows service/build/config versions and vendor/audit limitations", () => {
    const wrapper = mount(OneFetchCapabilities, { props: { capabilities: capabilities() }, global });
    expect(wrapper.text()).toContain("node · 0.1.1");
    expect(wrapper.text()).toContain("fixture-1");
    expect(wrapper.text()).toContain("2026-09-22");
    expect(wrapper.text()).toContain("oneFetchCapabilityNotice");
    expect(wrapper.text()).toContain("oneFetchTimingUnavailable");
    wrapper.unmount();
  });
});
