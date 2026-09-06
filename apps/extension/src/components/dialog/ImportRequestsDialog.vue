<script setup lang="ts">
import { FileInput, Globe2, Upload, X } from "lucide-vue-next";
import { ref } from "vue";

import AppDialog from "./AppDialog.vue";

defineProps<{
  text: string;
  detectedFormat: string;
  warnings: string[];
  canImportCurrentHar: boolean;
}>();
const emit = defineEmits<{
  close: [];
  import: [];
  files: [event: Event];
  currentHar: [];
  "update:text": [value: string];
}>();
const fileInput = ref<HTMLInputElement>();
</script>

<template>
  <AppDialog
    labelled-by="import-dialog-title"
    :aria-label="$t('importDialogLabel')"
    @close="emit('close')"
  >
    <header>
      <div>
        <span class="eyebrow">{{ $t("universalImporter") }}</span>
        <h2 id="import-dialog-title">{{ $t("importRequests") }}</h2>
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
    <div class="dialog-actions">
      <button
        class="ghost-button"
        type="button"
        data-dialog-initial-focus
        @click="fileInput?.click()"
      >
        <FileInput :size="15" /> {{ $t("chooseFiles") }}
      </button>
      <button
        class="ghost-button"
        type="button"
        :disabled="!canImportCurrentHar"
        :title="canImportCurrentHar ? undefined : $t('currentHarDevtoolsOnly')"
        @click="emit('currentHar')"
      >
        <Globe2 :size="15" /> {{ $t("currentHar") }}
      </button>
      <input
        ref="fileInput"
        hidden
        multiple
        type="file"
        accept=".txt,.json,.har,.yaml,.yml,.sh,.bash,.ps1,.js,.mjs,.cjs"
        @change="emit('files', $event)"
      />
      <span class="detected-format">
        {{ $t("detected") }}: {{ detectedFormat }}
      </span>
      <span v-if="!canImportCurrentHar" class="dialog-capability-note">
        {{ $t("currentHarDevtoolsOnly") }}
      </span>
    </div>
    <textarea
      :value="text"
      class="dialog-editor"
      spellcheck="false"
      :placeholder="$t('importPlaceholder')"
      @input="emit('update:text', ($event.target as HTMLTextAreaElement).value)"
    />
    <ul v-if="warnings.length" class="warning-list">
      <li v-for="warning in warnings" :key="warning">{{ warning }}</li>
    </ul>
    <footer>
      <button class="ghost-button" type="button" @click="emit('close')">
        {{ $t("cancel") }}
      </button>
      <button
        class="primary-button"
        type="button"
        :disabled="!text.trim()"
        @click="emit('import')"
      >
        <Upload :size="15" /> {{ $t("import") }}
      </button>
    </footer>
  </AppDialog>
</template>
