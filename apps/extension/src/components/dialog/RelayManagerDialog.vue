<script setup lang="ts">
import {
  Check,
  Globe2,
  LoaderCircle,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-vue-next";

import type {
  RemoteCapabilitiesV1,
  RemoteRelayProfileV1,
} from "@xpanel/contracts";

import AppDialog from "./AppDialog.vue";

defineProps<{
  profiles: RemoteRelayProfileV1[];
  draft: RemoteRelayProfileV1;
  token: string;
  persistConfirmed: boolean;
  busy: boolean;
  error: string;
  notice: string;
  capabilities: RemoteCapabilitiesV1 | null;
}>();

const emit = defineEmits<{
  close: [];
  create: [];
  edit: [profile: RemoteRelayProfileV1];
  remove: [profile: RemoteRelayProfileV1];
  test: [];
  save: [];
  "update:token": [value: string];
  "update:persistConfirmed": [value: boolean];
}>();
</script>

<template>
  <AppDialog
    card-class="relay-dialog"
    labelled-by="relay-manager-title"
    :busy="busy"
    @close="emit('close')"
  >
    <header>
      <div>
        <span class="eyebrow">Relay V1</span>
        <h2 id="relay-manager-title">{{ $t("relayProfiles") }}</h2>
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
    <div class="relay-manager-content">
      <aside class="relay-profile-list">
        <div class="relay-profile-list-header">
          <strong>{{ $t("relayProfiles") }}</strong>
          <button
            class="icon-button"
            type="button"
            :disabled="busy"
            :aria-label="$t('addRelayProfile')"
            @click="emit('create')"
          >
            <Plus :size="15" />
          </button>
        </div>
        <p v-if="profiles.length === 0" class="empty-note">
          {{ $t("noRelayProfiles") }}
        </p>
        <div
          v-for="profile in profiles"
          :key="profile.id"
          class="relay-profile-item"
          :data-active="profile.id === draft.id"
        >
          <button
            class="relay-profile-summary"
            type="button"
            :disabled="busy"
            @click="emit('edit', profile)"
          >
            <strong>{{ profile.name }}</strong><span>{{ profile.baseUrl }}</span>
          </button>
          <button
            class="icon-button delete-icon"
            type="button"
            :disabled="busy"
            :aria-label="`${$t('deleteRelayProfile')}: ${profile.name}`"
            @click="emit('remove', profile)"
          >
            <Trash2 :size="14" />
          </button>
        </div>
      </aside>
      <div class="relay-profile-editor">
        <p class="empty-note">{{ $t("relayProfilesHint") }}</p>
        <div class="form-stack">
          <label>
            {{ $t("relayProfileName") }}
            <input
              v-model="draft.name"
              class="field"
              autocomplete="off"
              data-dialog-initial-focus
              :disabled="busy"
            />
          </label>
          <label>
            {{ $t("relayBaseUrl") }}
            <input
              v-model="draft.baseUrl"
              class="field"
              inputmode="url"
              autocomplete="off"
              placeholder="https://xpanel-relay.example.workers.dev"
              :disabled="busy"
            />
          </label>
          <label>
            {{ $t("relayToken") }}
            <input
              :value="token"
              class="field"
              type="password"
              autocomplete="new-password"
              :placeholder="$t('relayTokenPlaceholder')"
              :disabled="busy"
              @input="emit('update:token', ($event.target as HTMLInputElement).value)"
            />
          </label>
          <label class="check-row">
            <input v-model="draft.tokenStorage" type="radio" value="session" :disabled="busy" />
            {{ $t("relayTokenSession") }}
          </label>
          <label class="check-row">
            <input v-model="draft.tokenStorage" type="radio" value="local" :disabled="busy" />
            {{ $t("relayTokenLocal") }}
          </label>
          <div v-if="draft.tokenStorage === 'local'" class="relay-token-warning">
            <p>{{ $t("relayTokenLocalWarning") }}</p>
            <label class="check-row">
              <input
                :checked="persistConfirmed"
                type="checkbox"
                :disabled="busy"
                @change="emit('update:persistConfirmed', ($event.target as HTMLInputElement).checked)"
              />
              {{ $t("relayPersistConfirm") }}
            </label>
          </div>
          <div class="relay-profile-actions">
            <button class="ghost-button" type="button" :disabled="busy" @click="emit('test')">
              <LoaderCircle v-if="busy" class="spin" :size="14" />
              <Globe2 v-else :size="14" />
              {{ busy ? $t("testingConnection") : $t("testConnection") }}
            </button>
            <button class="primary-button" type="button" :disabled="busy" @click="emit('save')">
              <Save :size="14" /> {{ $t("saveRequest") }}
            </button>
          </div>
          <p v-if="error" class="dialog-error" role="alert">{{ error }}</p>
          <p v-if="notice" class="relay-test-result" role="status">
            <Check :size="14" /> {{ notice }}
          </p>
          <span v-if="capabilities" class="sr-only">
            {{ capabilities.provider }} {{ capabilities.targetPolicy }}
          </span>
        </div>
      </div>
    </div>
    <footer>
      <button class="ghost-button" type="button" :disabled="busy" @click="emit('close')">
        {{ $t("cancel") }}
      </button>
    </footer>
  </AppDialog>
</template>
