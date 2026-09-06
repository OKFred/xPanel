<script setup lang="ts">
import { ChevronDown } from "lucide-vue-next";
import { computed, nextTick, ref, useId } from "vue";

const props = defineProps<{
  modelValue: string;
  label: string;
  invalidMessage: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{ "update:modelValue": [value: string] }>();
const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const tokenPattern = /^[!#$%&'*+.^_`|~0-9A-Z-]+$/u;
const open = ref(false);
const activeIndex = ref(-1);
const input = ref<HTMLInputElement>();
const listboxId = `http-methods-${useId()}`;
const errorId = `${listboxId}-error`;

const normalizedValue = computed(() => props.modelValue.toUpperCase());
const valid = computed(
  () => normalizedValue.value.length > 0 && tokenPattern.test(normalizedValue.value),
);

function update(value: string): void {
  emit("update:modelValue", value.toUpperCase());
}

function showOptions(): void {
  if (props.disabled) return;
  open.value = true;
  activeIndex.value = Math.max(
    0,
    methods.findIndex((method) => method === normalizedValue.value),
  );
}

function toggleOptions(): void {
  if (open.value) open.value = false;
  else showOptions();
  void nextTick(() => input.value?.focus());
}

function select(method: string): void {
  update(method);
  open.value = false;
  activeIndex.value = methods.indexOf(method);
  void nextTick(() => input.value?.focus());
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (!open.value) showOptions();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    activeIndex.value =
      (activeIndex.value + delta + methods.length) % methods.length;
    return;
  }
  if (event.key === "Enter" && open.value) {
    event.preventDefault();
    select(methods[activeIndex.value] ?? methods[0]!);
    return;
  }
  if (event.key === "Escape" && open.value) {
    event.preventDefault();
    open.value = false;
  }
}

function handleFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget;
  if (!(next instanceof Node) || !(event.currentTarget as HTMLElement).contains(next)) {
    open.value = false;
  }
}
</script>

<template>
  <div class="method-combobox" @focusout="handleFocusOut">
    <input
      ref="input"
      :value="normalizedValue"
      class="method-select"
      role="combobox"
      autocomplete="off"
      spellcheck="false"
      :aria-label="label"
      :aria-controls="listboxId"
      :aria-expanded="open"
      :aria-activedescendant="
        open ? `${listboxId}-option-${activeIndex}` : undefined
      "
      :aria-describedby="valid ? undefined : errorId"
      :aria-invalid="valid ? undefined : 'true'"
      :disabled="disabled"
      @focus="showOptions"
      @input="update(($event.target as HTMLInputElement).value)"
      @keydown="handleKeydown"
    />
    <button
      class="method-combobox-toggle"
      type="button"
      tabindex="-1"
      :aria-label="label"
      :aria-expanded="open"
      :disabled="disabled"
      @mousedown.prevent
      @click="toggleOptions"
    >
      <ChevronDown :size="13" />
    </button>
    <ul v-if="open" :id="listboxId" class="method-listbox" role="listbox">
      <li
        v-for="(method, index) in methods"
        :id="`${listboxId}-option-${index}`"
        :key="method"
        role="option"
        :aria-selected="method === normalizedValue"
        :data-active="index === activeIndex"
        @mousedown.prevent="select(method)"
      >
        {{ method }}
      </li>
    </ul>
    <span v-if="!valid" :id="errorId" class="sr-only" role="alert">
      {{ invalidMessage }}
    </span>
  </div>
</template>
