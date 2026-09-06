<script setup lang="ts">
import {
  Check,
  Clipboard,
  Download,
  Globe2,
  LoaderCircle,
} from "lucide-vue-next";
import { computed } from "vue";

import type { ResponseRecordV1 } from "@xpanel/contracts";

import ResponseDocumentViewer from "../response/ResponseDocumentViewer.vue";
import type { StoredResponseMetadata } from "../../lib/execution-client";

type ResponseTab = "pretty" | "raw" | "headers" | "timing";

const props = defineProps<{
  response: ResponseRecordV1 | StoredResponseMetadata | null;
  bodySource?: Blob | string | null;
  prettySource?: Blob | null;
  busy: boolean;
  tab: ResponseTab;
  headersText: string;
  timingText: string;
  copied: string;
}>();

const emit = defineEmits<{
  "update:tab": [value: ResponseTab];
  copyBody: [];
  copyHeaders: [];
  copyFull: [];
  downloadBody: [];
  viewerError: [message: string];
}>();

const inlineBody = computed(() =>
  props.response?.body.kind === "inline" ? props.response.body.content : null,
);
const documentSource = computed(
  () =>
    (props.tab === "pretty" ? props.prettySource : undefined) ??
    props.bodySource ??
    inlineBody.value,
);
const documentMode = computed<"pretty" | "raw">(() =>
  props.tab === "pretty" && props.prettySource
    ? "raw"
    : props.tab === "pretty"
      ? "pretty"
      : "raw",
);
</script>

<template>
  <section class="response-pane">
    <div class="response-heading">
      <div>
        <span class="eyebrow">{{ $t("response") }}</span>
        <strong
          v-if="response"
          :data-ok="response.status >= 200 && response.status < 400"
        >
          {{ response.status }} {{ response.statusText }}
        </strong>
        <span v-else>{{ $t("noResponse") }}</span>
      </div>
      <div v-if="response" class="response-meta">
        {{
          $t(
            response.executor === "remote"
              ? "remoteRelayShort"
              : "browserExecutor",
          )
        }}
        · {{ Math.round(response.timings.durationMs) }} ms ·
        {{ response.body.sizeBytes }} B
      </div>
    </div>
    <ul v-if="response?.warnings.length" class="response-warning-list">
      <li
        v-for="warning in response.warnings"
        :key="`${warning.code}-${warning.path ?? ''}`"
      >
        {{ warning.message }}
      </li>
    </ul>
    <nav class="tab-list response-tabs">
      <button
        v-for="item in ['pretty', 'raw', 'headers', 'timing'] as const"
        :key="item"
        type="button"
        :data-active="tab === item"
        @click="emit('update:tab', item)"
      >
        {{ $t(item === "headers" ? "responseHeaders" : item) }}
      </button>
      <button
        class="copy-action"
        type="button"
        :disabled="!response"
        @click="emit('copyBody')"
      >
        <Check v-if="copied === 'body'" :size="14" />
        <Clipboard v-else :size="14" /> {{ $t("copyBody") }}
      </button>
      <button type="button" :disabled="!response" @click="emit('copyHeaders')">
        <Check v-if="copied === 'response-headers'" :size="14" />
        <Clipboard v-else :size="14" /> {{ $t("copyHeaders") }}
      </button>
      <button type="button" :disabled="!response" @click="emit('copyFull')">
        <Check v-if="copied === 'full-response'" :size="14" />
        <Clipboard v-else :size="14" /> {{ $t("copyFull") }}
      </button>
      <button
        type="button"
        :disabled="!documentSource"
        @click="emit('downloadBody')"
      >
        <Download :size="14" /> {{ $t("download") }}
      </button>
    </nav>
    <div class="response-content">
      <div v-if="busy && !response" class="response-empty">
        <LoaderCircle class="spin" :size="28" /> {{ $t("sending") }}
      </div>
      <ResponseDocumentViewer
        v-else-if="
          response && documentSource && (tab === 'pretty' || tab === 'raw')
        "
        :key="`${response.requestId}-${tab}-${response.body.sizeBytes}`"
        :source="documentSource"
        :size-bytes="response.body.sizeBytes"
        :mode="documentMode"
        :encoding="response.body.encoding"
        :aria-label="
          $t(tab === 'pretty' ? 'prettyResponseBody' : 'rawResponseBody')
        "
        :loading-label="$t('preparingResponseView')"
        @error="emit('viewerError', $event)"
      />
      <pre v-else-if="response && tab === 'headers'">{{ headersText }}</pre>
      <pre v-else-if="response && tab === 'timing'">{{ timingText }}</pre>
      <div v-else class="response-empty">
        <Globe2 :size="30" /> {{ $t("sendHint") }}
      </div>
    </div>
  </section>
</template>
