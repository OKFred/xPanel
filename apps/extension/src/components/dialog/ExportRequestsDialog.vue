<script setup lang="ts">
import { Check, Clipboard, Download, X } from "lucide-vue-next";

import type { ExportFormat } from "@xpanel/request-core";

import AppDialog from "./AppDialog.vue";

defineProps<{
  format: ExportFormat;
  scope: "current" | "saved";
  openApiVersion: "3.0.3" | "3.1.0" | "3.2.0";
  encoding: "json" | "yaml";
  includeSensitive: boolean;
  text: string;
  warnings: string[];
  copied: boolean;
}>();

const emit = defineEmits<{
  close: [];
  prepare: [];
  sensitive: [event: Event];
  copy: [];
  download: [];
  "update:format": [value: ExportFormat];
  "update:scope": [value: "current" | "saved"];
  "update:openApiVersion": [value: "3.0.3" | "3.1.0" | "3.2.0"];
  "update:encoding": [value: "json" | "yaml"];
  "update:text": [value: string];
}>();
</script>

<template>
  <AppDialog
    labelled-by="export-dialog-title"
    :aria-label="$t('exportRequests')"
    @close="emit('close')"
  >
    <header>
      <div>
        <span class="eyebrow">{{ $t("safeByDefault") }}</span>
        <h2 id="export-dialog-title">{{ $t("exportRequests") }}</h2>
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
      <select
        :value="format"
        data-dialog-initial-focus
        @change="
          emit(
            'update:format',
            ($event.target as HTMLSelectElement).value as ExportFormat,
          );
          emit('prepare');
        "
      >
        <option value="curl-bash">cURL (Bash)</option>
        <option value="powershell">PowerShell</option>
        <option value="fetch-node">Node fetch</option>
        <option value="har">HAR 1.2</option>
        <option value="openapi">OpenAPI 3</option>
        <option value="swagger">Swagger 2</option>
        <option value="xpanel-collection">xPanel collection</option>
      </select>
      <select
        :value="scope"
        @change="
          emit(
            'update:scope',
            ($event.target as HTMLSelectElement).value as 'current' | 'saved',
          );
          emit('prepare');
        "
      >
        <option value="current">{{ $t("currentRequest") }}</option>
        <option value="saved">{{ $t("savedRequests") }}</option>
      </select>
      <select
        v-if="format === 'openapi'"
        :value="openApiVersion"
        @change="
          emit(
            'update:openApiVersion',
            ($event.target as HTMLSelectElement).value as
              | '3.0.3'
              | '3.1.0'
              | '3.2.0',
          );
          emit('prepare');
        "
      >
        <option value="3.0.3">OpenAPI 3.0.3</option>
        <option value="3.1.0">OpenAPI 3.1.0</option>
        <option value="3.2.0">OpenAPI 3.2.0</option>
      </select>
      <select
        v-if="format === 'openapi' || format === 'swagger'"
        :value="encoding"
        @change="
          emit(
            'update:encoding',
            ($event.target as HTMLSelectElement).value as 'json' | 'yaml',
          );
          emit('prepare');
        "
      >
        <option value="json">JSON</option>
        <option value="yaml">YAML</option>
      </select>
      <label class="check-row">
        <input
          :checked="includeSensitive"
          type="checkbox"
          @change="emit('sensitive', $event)"
        />
        {{ $t("includeSensitive") }}
      </label>
    </div>
    <textarea
      :value="text"
      class="dialog-editor"
      spellcheck="false"
      @input="emit('update:text', ($event.target as HTMLTextAreaElement).value)"
    />
    <ul v-if="warnings.length" class="warning-list">
      <li v-for="warning in warnings" :key="warning">{{ warning }}</li>
    </ul>
    <footer>
      <button class="ghost-button" type="button" @click="emit('copy')">
        <Check v-if="copied" :size="15" />
        <Clipboard v-else :size="15" /> {{ $t("copy") }}
      </button>
      <button class="primary-button" type="button" @click="emit('download')">
        <Download :size="15" /> {{ $t("download") }}
      </button>
    </footer>
  </AppDialog>
</template>
