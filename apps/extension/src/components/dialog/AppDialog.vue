<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";

const props = withDefaults(
  defineProps<{
    labelledBy: string;
    ariaLabel?: string | undefined;
    describedBy?: string | undefined;
    role?: "dialog" | "alertdialog";
    busy?: boolean;
    cardClass?: string;
  }>(),
  {
    ariaLabel: undefined,
    describedBy: undefined,
    role: "dialog",
    busy: false,
    cardClass: "",
  },
);

const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
let returnFocus: HTMLElement | null = null;

const focusableSelector = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableElements(): HTMLElement[] {
  if (!dialog.value) return [];
  const elements = [
    ...dialog.value.querySelectorAll<HTMLElement>(focusableSelector),
  ].filter(
    (element) =>
      !element.hidden && element.getAttribute("aria-hidden") !== "true",
  );
  const preferred = dialog.value.querySelector<HTMLElement>(
    "[data-dialog-initial-focus]:not([disabled])",
  );
  return preferred
    ? [preferred, ...elements.filter((element) => element !== preferred)]
    : elements;
}

function requestClose(): void {
  if (!props.busy) emit("close");
}

function handleCancel(event: Event): void {
  event.preventDefault();
  requestClose();
}

function handleBackdrop(event: MouseEvent): void {
  if (event.target === dialog.value) requestClose();
}

function trapTab(event: KeyboardEvent): void {
  if (event.key !== "Tab") return;
  const focusable = focusableElements();
  if (focusable.length === 0) {
    event.preventDefault();
    dialog.value?.focus();
    return;
  }
  const first = focusable[0]!;
  const last = focusable.at(-1)!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

onMounted(() => {
  returnFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const element = dialog.value;
  if (!element) return;
  if (typeof element.showModal === "function") element.showModal();
  else element.setAttribute("open", "");
  void nextTick(() => focusableElements()[0]?.focus());
});

onBeforeUnmount(() => {
  const element = dialog.value;
  if (element?.open && typeof element.close === "function") element.close();
  const target = returnFocus;
  void nextTick(() => {
    if (target?.isConnected) target.focus();
  });
});
</script>

<template>
  <dialog
    ref="dialog"
    class="app-dialog"
    :role="role"
    aria-modal="true"
    :aria-labelledby="labelledBy"
    :aria-label="ariaLabel"
    :aria-describedby="describedBy"
    @cancel="handleCancel"
    @click="handleBackdrop"
    @keydown="trapTab"
  >
    <section class="dialog-card" :class="cardClass" @click.stop>
      <slot />
    </section>
  </dialog>
</template>
