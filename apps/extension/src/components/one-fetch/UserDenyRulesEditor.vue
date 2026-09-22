<script setup lang="ts">
import { computed } from "vue";
import { UserDenyRulesV1Schema } from "@one-fetch/protocol";
const text = defineModel<string>({ required: true });
defineProps<{ disabled: boolean }>();
const parsed = computed(() => {
  try {
    return UserDenyRulesV1Schema.safeParse(JSON.parse(text.value));
  } catch {
    return null;
  }
});
const error = computed(() =>
  parsed.value?.success
    ? ""
    : (parsed.value?.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("\n") ?? "Invalid JSON"),
);
function example(): void {
  text.value = JSON.stringify(
    {
      schemaVersion: 1,
      rules: [
        {
          id: "example-delete",
          name: "Block DELETE (example)",
          enabled: false,
          action: "deny",
          match: { methods: ["DELETE"] },
        },
      ],
    },
    null,
    2,
  );
}
function toggle(index: number, enabled: boolean): void {
  if (!parsed.value?.success) return;
  const rules = parsed.value.data;
  if (rules.rules[index]) rules.rules[index].enabled = enabled;
  text.value = JSON.stringify(rules, null, 2);
}
</script>
<template>
  <details>
    <summary>{{ $t("oneFetchUserDenyRules") }}</summary>
    <p class="empty-note">{{ $t("oneFetchUserRulesHint") }}</p>
    <button
      type="button"
      :disabled="disabled || (parsed?.success && parsed.data.rules.length > 0)"
      @click="example"
    >
      {{ $t("oneFetchRuleExample") }}
    </button>
    <textarea
      v-model="text"
      class="field"
      rows="10"
      spellcheck="false"
      :disabled="disabled"
      :aria-label="$t('oneFetchUserDenyRules')"
    />
    <p v-if="error" role="alert" class="dialog-error">{{ error }}</p>
    <template v-if="parsed?.success">
      <label
        v-for="(rule, index) in parsed.data.rules"
        :key="rule.id"
        class="check-row"
      >
        <input
          type="checkbox"
          :checked="rule.enabled"
          :disabled="disabled"
          @change="toggle(index, ($event.target as HTMLInputElement).checked)"
        />
        {{ rule.name }}
      </label>
    </template>
  </details>
</template>
