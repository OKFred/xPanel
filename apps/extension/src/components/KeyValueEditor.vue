<script setup lang="ts">
import { LockKeyhole, Plus, Trash2 } from "lucide-vue-next";

import { isSensitiveHeader, type KeyValueItem } from "@xpanel/contracts";

const props = withDefaults(
  defineProps<{
    modelValue: KeyValueItem[];
    namePlaceholder?: string;
    valuePlaceholder?: string;
    addLabel?: string;
    removeLabel?: string;
    enableLabel?: string;
    sensitiveLabel?: string;
    sensitiveTitle?: string;
    entryLabel?: string;
  }>(),
  {
    namePlaceholder: "Name",
    valuePlaceholder: "Value",
    addLabel: "Add",
    removeLabel: "Remove",
    enableLabel: "Enable",
    sensitiveLabel: "Sensitive",
    sensitiveTitle: "Treat as sensitive",
    entryLabel: "entry",
  },
);

const emit = defineEmits<{ "update:modelValue": [value: KeyValueItem[]] }>();

function update(index: number, patch: Partial<KeyValueItem>): void {
  const next = props.modelValue.map((item, itemIndex) =>
    itemIndex === index ? { ...item, ...patch } : item,
  );
  emit("update:modelValue", next);
}

function add(): void {
  emit("update:modelValue", [
    ...props.modelValue,
    { name: "", value: "", enabled: true },
  ]);
}

function remove(index: number): void {
  emit(
    "update:modelValue",
    props.modelValue.filter((_, itemIndex) => itemIndex !== index),
  );
}

function updateName(index: number, item: KeyValueItem, name: string): void {
  update(index, {
    name,
    ...(item.sensitive === true || isSensitiveHeader(name)
      ? { sensitive: true }
      : {}),
  });
}
</script>

<template>
  <div class="kv-editor">
    <div v-for="(item, index) in modelValue" :key="index" class="kv-row">
      <input
        type="checkbox"
        :checked="item.enabled !== false"
        :aria-label="`${enableLabel} ${item.name || entryLabel}`"
        @change="
          update(index, {
            enabled: ($event.target as HTMLInputElement).checked,
          })
        "
      />
      <input
        class="field"
        :placeholder="namePlaceholder"
        :value="item.name"
        @input="
          updateName(index, item, ($event.target as HTMLInputElement).value)
        "
      />
      <input
        class="field"
        :placeholder="valuePlaceholder"
        :value="item.value"
        @input="
          update(index, { value: ($event.target as HTMLInputElement).value })
        "
      />
      <label
        class="sensitive-toggle"
        :title="`${sensitiveTitle}: ${item.name || entryLabel}`"
      >
        <LockKeyhole :size="13" />
        <input
          type="checkbox"
          :checked="item.sensitive === true || isSensitiveHeader(item.name)"
          :aria-label="`${sensitiveLabel} ${item.name || entryLabel}`"
          @change="
            update(index, {
              sensitive: ($event.target as HTMLInputElement).checked,
            })
          "
        />
      </label>
      <button
        class="icon-button"
        type="button"
        :aria-label="removeLabel"
        @click="remove(index)"
      >
        <Trash2 :size="15" />
      </button>
    </div>
    <button class="ghost-button add-row" type="button" @click="add">
      <Plus :size="15" /> {{ addLabel }}
    </button>
  </div>
</template>
