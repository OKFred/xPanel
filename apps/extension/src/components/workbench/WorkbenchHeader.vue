<script setup lang="ts">
import {
  Download,
  Heart,
  LoaderCircle,
  Play,
  Save,
  Settings2,
  Square,
  Upload,
} from "lucide-vue-next";

import type {
  CollectionRecord,
  ExecutionProgressV1,
  RemoteRelayProfileV1,
  RequestSpecV1,
} from "@xpanel/contracts";

import HttpMethodCombobox from "../HttpMethodCombobox.vue";

defineProps<{
  current: RequestSpecV1;
  collections: CollectionRecord[];
  selectedCollectionId: string;
  relayProfiles: RemoteRelayProfileV1[];
  executorSelection: string;
  busy: boolean;
  cancelling: boolean;
  progress: ExecutionProgressV1 | null;
  progressPercent: number | undefined;
  progressPhaseLabel: string;
  progressDetail: string;
  displayCollectionName: (collection: CollectionRecord) => string;
}>();

const emit = defineEmits<{
  import: [];
  export: [];
  favorite: [];
  save: [];
  manageRelays: [];
  send: [];
  stop: [];
  "update:selectedCollectionId": [value: string];
  "update:executorSelection": [value: string];
}>();
</script>

<template>
  <header class="toolbar">
    <input v-model="current.name" class="request-name" :aria-label="$t('requestName')" />
    <select
      :value="selectedCollectionId"
      :aria-label="$t('saveToCollection')"
      @change="emit('update:selectedCollectionId', ($event.target as HTMLSelectElement).value)"
    >
      <option v-for="collection in collections" :key="collection.id" :value="collection.id">
        {{ displayCollectionName(collection) }}
      </option>
    </select>
    <div class="toolbar-actions">
      <button class="ghost-button" type="button" :disabled="busy" @click="emit('import')">
        <Upload :size="15" /> <span>{{ $t("import") }}</span>
      </button>
      <button class="ghost-button" type="button" @click="emit('export')">
        <Download :size="15" /> <span>{{ $t("export") }}</span>
      </button>
      <button class="ghost-button" type="button" @click="emit('favorite')">
        <Heart :size="15" :fill="current.favorite ? 'currentColor' : 'none'" />
        <span>{{ $t("save") }}</span>
      </button>
      <button class="ghost-button" type="button" @click="emit('save')">
        <Save :size="15" /> <span>{{ $t("saveRequest") }}</span>
      </button>
    </div>
  </header>

  <div class="request-bar">
    <HttpMethodCombobox
      v-model="current.method"
      :label="$t('httpMethod')"
      :invalid-message="$t('invalidHttpMethod')"
      :disabled="busy"
    />
    <select
      :value="executorSelection"
      class="executor-select"
      :aria-label="$t('executor')"
      :disabled="busy"
      @change="emit('update:executorSelection', ($event.target as HTMLSelectElement).value)"
    >
      <option value="browser">{{ $t("browserExecutor") }}</option>
      <option v-for="profile in relayProfiles" :key="profile.id" :value="profile.id">
        {{ $t("remoteExecutor", { name: profile.name }) }}
      </option>
    </select>
    <button
      class="relay-manage-button"
      type="button"
      :aria-label="$t('manageRelays')"
      :disabled="busy"
      @click="emit('manageRelays')"
    >
      <Settings2 :size="15" />
    </button>
    <input
      v-model="current.url"
      class="url-input"
      placeholder="https://api.example.com/v1/resource"
      :aria-label="$t('requestUrl')"
      @keyup.enter="emit('send')"
    />
    <button v-if="!busy" class="send-button" type="button" @click="emit('send')">
      <Play :size="16" fill="currentColor" /> {{ $t("send") }}
    </button>
    <button
      v-else
      class="stop-button"
      type="button"
      :disabled="cancelling"
      @click="emit('stop')"
    >
      <LoaderCircle v-if="cancelling" class="spin" :size="15" />
      <Square v-else :size="15" fill="currentColor" />
      {{ cancelling ? $t("cancelling") : $t("stop") }}
    </button>
  </div>

  <div class="workbench-status-region">
    <div
      v-if="progress"
      class="execution-progress"
      role="progressbar"
      aria-valuemin="0"
      :aria-valuemax="progressPercent === undefined ? undefined : progress.totalBytes"
      :aria-valuenow="progressPercent === undefined ? undefined : progress.loadedBytes"
      :aria-label="progressPhaseLabel"
      :aria-valuetext="progressDetail"
      aria-live="polite"
    >
      <span class="progress-phase">{{ progressPhaseLabel }}</span>
      <span
        class="progress-track"
        :data-indeterminate="progressPercent === undefined"
        :data-cancelling="progress.phase === 'cancelling'"
        aria-hidden="true"
      >
        <span
          class="progress-fill"
          :style="progressPercent === undefined ? undefined : { width: `${progressPercent}%` }"
        />
      </span>
      <span class="progress-detail">{{ progressDetail }}</span>
    </div>
    <slot name="message" />
  </div>
</template>
