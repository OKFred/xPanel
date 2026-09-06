<script setup lang="ts">
import { X } from "lucide-vue-next";

import AppDialog from "./AppDialog.vue";

defineProps<{ reasons: string[]; filterableHeaderCount: number }>();
const emit = defineEmits<{ close: []; filter: []; remote: [] }>();
</script>

<template>
  <AppDialog
    role="alertdialog"
    card-class="confirm-dialog"
    labelled-by="browser-compatibility-title"
    described-by="browser-compatibility-description"
    @close="emit('close')"
  >
    <header>
      <div>
        <span class="eyebrow">Browser Fetch</span>
        <h2 id="browser-compatibility-title">
          {{ $t("browserCompatibilityTitle") }}
        </h2>
      </div>
      <button
        class="icon-button"
        type="button"
        :aria-label="$t('closeDialog')"
        @click="emit('close')"
      >
        <X :size="18" />
      </button>
    </header>
    <div class="confirmation-content">
      <p id="browser-compatibility-description">
        {{ $t("browserCompatibilityDescription") }}
      </p>
      <ul class="relay-data-list">
        <li v-for="reason in reasons" :key="reason">{{ reason }}</li>
      </ul>
      <p>{{ $t("browserUnsupportedRemoteHint") }}</p>
    </div>
    <footer>
      <button
        class="ghost-button"
        type="button"
        data-dialog-initial-focus
        @click="emit('close')"
      >
        {{ $t("cancel") }}
      </button>
      <button
        v-if="filterableHeaderCount > 0"
        class="ghost-button"
        type="button"
        @click="emit('filter')"
      >
        {{ $t("filterOnceAndSend", { count: filterableHeaderCount }) }}
      </button>
      <button class="primary-button" type="button" @click="emit('remote')">
        {{ $t("switchToRemote") }}
      </button>
    </footer>
  </AppDialog>
</template>
