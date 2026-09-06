<script setup lang="ts">
import { LoaderCircle, Play, X } from "lucide-vue-next";

import AppDialog from "./AppDialog.vue";

defineProps<{
  busy: boolean;
  error: string;
  target: string;
  relay: string;
  baseUrl: string;
  trustSession: boolean;
}>();
const emit = defineEmits<{
  close: [];
  confirm: [];
  "update:trustSession": [value: boolean];
}>();
</script>

<template>
  <AppDialog
    role="alertdialog"
    card-class="confirm-dialog"
    labelled-by="remote-consent-title"
    described-by="remote-consent-description"
    :busy="busy"
    @close="emit('close')"
  >
    <header>
      <div>
        <span class="eyebrow">Remote Relay</span>
        <h2 id="remote-consent-title">{{ $t("relayConsentTitle") }}</h2>
      </div>
      <button
        class="icon-button"
        type="button"
        :disabled="busy"
        :aria-label="$t('closeDialog')"
        @click="emit('close')"
      >
        <X :size="18" />
      </button>
    </header>
    <div class="confirmation-content">
      <p id="remote-consent-description">
        {{ $t("relayConsentIntro", { target, relay }) }}
      </p>
      <div class="relay-consent-map">
        <span>{{ target }}</span
        ><span aria-hidden="true">→</span><span>{{ baseUrl }}</span>
      </div>
      <strong>{{ $t("relayDataHeading") }}</strong>
      <ul class="relay-data-list">
        <li>{{ $t("relayDataUrl") }}</li>
        <li>{{ $t("relayDataHeaders") }}</li>
        <li>{{ $t("relayDataBody") }}</li>
      </ul>
      <p class="remote-cookie-note">{{ $t("remoteSetCookieNotice") }}</p>
      <label class="check-row">
        <input
          :checked="trustSession"
          type="checkbox"
          :disabled="busy"
          @change="
            emit(
              'update:trustSession',
              ($event.target as HTMLInputElement).checked,
            )
          "
        />
        {{ $t("relayTrustSession") }}
      </label>
      <p class="empty-note">{{ $t("remoteNotAutomatic") }}</p>
      <p v-if="error" class="dialog-error" role="alert">{{ error }}</p>
    </div>
    <footer>
      <button
        class="ghost-button"
        type="button"
        data-dialog-initial-focus
        :disabled="busy"
        @click="emit('close')"
      >
        {{ $t("cancel") }}
      </button>
      <button
        class="primary-button"
        type="button"
        :disabled="busy"
        @click="emit('confirm')"
      >
        <LoaderCircle v-if="busy" class="spin" :size="15" />
        <Play v-else :size="15" /> {{ $t("sendRemote") }}
      </button>
    </footer>
  </AppDialog>
</template>
