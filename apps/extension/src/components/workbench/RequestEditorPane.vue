<script setup lang="ts">
import { Braces, FileInput, Plus, X } from "lucide-vue-next";

import type {
  AuthSpec,
  BodySpec,
  RequestSpecV1,
  ResultRetentionV1,
} from "@xpanel/contracts";

import HostAccessControl from "../HostAccessControl.vue";
import KeyValueEditor from "../KeyValueEditor.vue";

type RequestTab = "params" | "headers" | "body" | "auth" | "options";

const current = defineModel<RequestSpecV1>("current", { required: true });
defineProps<{
  tab: RequestTab;
  bodyKind: BodySpec["kind"];
  bodyText: string;
  timeoutSeconds: string;
  autoFilterBrowserHeaders: boolean;
  persistSensitive: boolean;
  hasHiddenBrowserOptions: boolean;
  busy: boolean;
  retention: ResultRetentionV1;
  responseLimitMiB: number;
}>();

const emit = defineEmits<{
  "update:tab": [value: RequestTab];
  "update:bodyText": [value: string];
  "update:autoFilterBrowserHeaders": [value: boolean];
  "update:persistSensitive": [value: boolean];
  "update:retention": [value: ResultRetentionV1];
  "update:responseLimitMiB": [value: number];
  timeoutFocus: [];
  timeoutInput: [event: Event];
  timeoutBlur: [];
  bodyKind: [kind: BodySpec["kind"]];
  authKind: [kind: AuthSpec["kind"]];
  prettyBody: [];
  compactBody: [];
  rawFile: [event: Event];
  addMultipartText: [];
  addMultipartFile: [];
  multipartFile: [index: number, event: Event];
  removeMultipart: [index: number];
  clearUnsupported: [];
  clearResults: [];
}>();
</script>

<template>
  <section class="request-pane">
    <nav class="tab-list" :aria-label="$t('requestTabs')">
      <button
        v-for="item in [
          'params',
          'headers',
          'body',
          'auth',
          'options',
        ] as const"
        :key="item"
        type="button"
        :data-active="tab === item"
        @click="emit('update:tab', item)"
      >
        {{ $t(item) }}
        <span v-if="item === 'params' && current.query.length" class="count">
          {{ current.query.length }}
        </span>
        <span v-if="item === 'headers' && current.headers.length" class="count">
          {{ current.headers.length }}
        </span>
      </button>
    </nav>
    <div class="tab-content">
      <KeyValueEditor
        v-if="tab === 'params'"
        v-model="current.query"
        :name-placeholder="$t('parameter')"
        :value-placeholder="$t('value')"
        :add-label="$t('add')"
        :remove-label="$t('remove')"
        :enable-label="$t('enable')"
        :sensitive-label="$t('sensitive')"
        :sensitive-title="$t('treatAsSensitive')"
        :entry-label="$t('entry')"
      />
      <KeyValueEditor
        v-else-if="tab === 'headers'"
        v-model="current.headers"
        :name-placeholder="$t('headerName')"
        :value-placeholder="$t('value')"
        :add-label="$t('add')"
        :remove-label="$t('remove')"
        :enable-label="$t('enable')"
        :sensitive-label="$t('sensitive')"
        :sensitive-title="$t('treatAsSensitive')"
        :entry-label="$t('entry')"
      />
      <div v-else-if="tab === 'body'" class="body-editor">
        <div class="inline-controls">
          <select
            :value="bodyKind"
            @change="
              emit(
                'bodyKind',
                ($event.target as HTMLSelectElement).value as BodySpec['kind'],
              )
            "
          >
            <option value="none">{{ $t("bodyNone") }}</option>
            <option value="json">JSON</option>
            <option value="text">{{ $t("bodyText") }}</option>
            <option value="file">{{ $t("bodyFile") }}</option>
            <option value="urlencoded">{{ $t("bodyUrlEncoded") }}</option>
            <option value="multipart">{{ $t("bodyMultipart") }}</option>
          </select>
          <template v-if="bodyKind === 'json'">
            <button
              class="ghost-button"
              type="button"
              @click="emit('prettyBody')"
            >
              <Braces :size="14" /> {{ $t("pretty") }}
            </button>
            <button
              class="ghost-button"
              type="button"
              @click="emit('compactBody')"
            >
              {{ $t("compact") }}
            </button>
          </template>
        </div>
        <textarea
          v-if="bodyKind === 'json' || bodyKind === 'text'"
          :value="bodyText"
          class="code-editor"
          spellcheck="false"
          :placeholder="$t('requestBody')"
          @input="
            emit(
              'update:bodyText',
              ($event.target as HTMLTextAreaElement).value,
            )
          "
        />
        <KeyValueEditor
          v-else-if="current.body.kind === 'urlencoded'"
          v-model="current.body.entries"
          :name-placeholder="$t('field')"
          :value-placeholder="$t('value')"
          :add-label="$t('add')"
          :remove-label="$t('remove')"
          :enable-label="$t('enable')"
          :sensitive-label="$t('sensitive')"
          :sensitive-title="$t('treatAsSensitive')"
          :entry-label="$t('entry')"
        />
        <div
          v-else-if="current.body.kind === 'file'"
          class="file-option raw-file-option"
        >
          <span>{{ $t("rawRequestBody") }}</span>
          <label class="file-picker ghost-button">
            <FileInput :size="14" /> {{ current.body.file.name }}
            <input type="file" @change="emit('rawFile', $event)" />
          </label>
          <input
            v-model="current.body.mediaType"
            class="field"
            :placeholder="$t('contentTypeOptional')"
          />
        </div>
        <div
          v-else-if="current.body.kind === 'multipart'"
          class="multipart-editor"
        >
          <div class="inline-controls">
            <button
              class="ghost-button"
              type="button"
              @click="emit('addMultipartText')"
            >
              <Plus :size="14" /> {{ $t("textField") }}
            </button>
            <button
              class="ghost-button"
              type="button"
              @click="emit('addMultipartFile')"
            >
              <FileInput :size="14" /> {{ $t("bodyFile") }}
            </button>
          </div>
          <div
            v-for="(part, index) in current.body.parts"
            :key="part.kind === 'file' ? part.file.id : `${part.name}-${index}`"
            class="multipart-row"
          >
            <input
              v-model="part.enabled"
              type="checkbox"
              :aria-label="$t('enableMultipartPart')"
            />
            <input
              v-model="part.name"
              class="field"
              :placeholder="$t('fieldName')"
            />
            <input
              v-if="part.kind === 'text'"
              v-model="part.value"
              class="field"
              :placeholder="$t('value')"
            />
            <label v-else class="file-picker ghost-button">
              <FileInput :size="14" /> {{ part.file.name }}
              <input
                type="file"
                @change="emit('multipartFile', index, $event)"
              />
            </label>
            <button
              class="icon-button"
              type="button"
              :aria-label="$t('removeMultipartPart')"
              @click="emit('removeMultipart', index)"
            >
              <X :size="14" />
            </button>
          </div>
          <p v-if="current.body.parts.length === 0" class="empty-note">
            {{ $t("multipartEmpty") }}
          </p>
        </div>
        <p v-else class="empty-note">{{ $t("requestNoBody") }}</p>
      </div>
      <div v-else-if="tab === 'auth'" class="form-stack">
        <label>
          {{ $t("authorization") }}
          <select
            :value="current.auth.kind"
            @change="
              emit(
                'authKind',
                ($event.target as HTMLSelectElement).value as AuthSpec['kind'],
              )
            "
          >
            <option value="none">{{ $t("authNone") }}</option>
            <option value="basic">{{ $t("authBasic") }}</option>
            <option value="bearer">{{ $t("authBearer") }}</option>
            <option value="api-key">{{ $t("authApiKey") }}</option>
            <option value="oauth2">{{ $t("authOauth2") }}</option>
          </select>
        </label>
        <template v-if="current.auth.kind === 'basic'">
          <input
            v-model="current.auth.username"
            class="field"
            :placeholder="$t('username')"
          />
          <input
            v-model="current.auth.password"
            class="field"
            type="password"
            :placeholder="$t('password')"
          />
        </template>
        <input
          v-else-if="current.auth.kind === 'bearer'"
          v-model="current.auth.token"
          class="field"
          type="password"
          :placeholder="$t('token')"
        />
        <template v-else-if="current.auth.kind === 'api-key'">
          <select v-model="current.auth.location">
            <option value="header">{{ $t("locationHeader") }}</option>
            <option value="query">{{ $t("locationQuery") }}</option>
            <option value="cookie" disabled>
              {{ $t("cookieBrowserUnsupported") }}
            </option>
          </select>
          <input
            v-model="current.auth.name"
            class="field"
            :placeholder="$t('name')"
          />
          <input
            v-model="current.auth.value"
            class="field"
            type="password"
            :placeholder="$t('value')"
          />
        </template>
        <template v-else-if="current.auth.kind === 'oauth2'">
          <input
            v-model="current.auth.tokenType"
            class="field"
            :placeholder="$t('tokenType')"
          />
          <input
            v-model="current.auth.accessToken"
            class="field"
            type="password"
            :placeholder="$t('accessToken')"
          />
        </template>
      </div>
      <div v-else class="form-stack options-grid">
        <label>
          {{ $t("timeoutSeconds") }}
          <input
            :value="timeoutSeconds"
            :aria-label="$t('timeoutSeconds')"
            class="field"
            type="number"
            min="0.001"
            max="86400"
            step="0.001"
            @focus="emit('timeoutFocus')"
            @input="emit('timeoutInput', $event)"
            @blur="emit('timeoutBlur')"
          />
        </label>
        <label>
          {{ $t("redirect") }}
          <select v-model="current.options.redirect">
            <option value="follow">{{ $t("redirectFollow") }}</option>
            <option value="manual">{{ $t("redirectManual") }}</option>
            <option value="error">{{ $t("redirectError") }}</option>
          </select>
        </label>
        <label>
          {{ $t("cookies") }}
          <select v-model="current.options.cookieMode">
            <option value="include">{{ $t("cookieInclude") }}</option>
            <option value="same-origin">{{ $t("cookieSameOrigin") }}</option>
            <option value="omit">{{ $t("cookieOmit") }}</option>
          </select>
        </label>
        <label>
          {{ $t("resultRetention") }}
          <select
            :value="retention"
            @change="
              emit(
                'update:retention',
                ($event.target as HTMLSelectElement).value as ResultRetentionV1,
              )
            "
          >
            <option value="10m">{{ $t("retention10m") }}</option>
            <option value="1h">{{ $t("retention1h") }}</option>
            <option value="session">{{ $t("retentionSession") }}</option>
            <option value="manual">{{ $t("retentionManual") }}</option>
          </select>
        </label>
        <label>
          {{ $t("responseLimitMiB") }}
          <input
            class="field"
            type="number"
            min="1"
            max="100"
            step="1"
            :value="responseLimitMiB"
            @change="
              emit(
                'update:responseLimitMiB',
                Number(($event.target as HTMLInputElement).value),
              )
            "
          />
        </label>
        <div class="compatibility-note">
          <span>{{ $t("localResultsHint") }}</span>
          <button
            class="ghost-button"
            type="button"
            :disabled="busy"
            @click="emit('clearResults')"
          >
            {{ $t("clearResults") }}
          </button>
        </div>
        <div v-if="hasHiddenBrowserOptions" class="compatibility-note">
          <span>{{ $t("unsupportedOptionsNote") }}</span>
          <button
            class="ghost-button"
            type="button"
            @click="emit('clearUnsupported')"
          >
            {{ $t("clearUnsupportedOptions") }}
          </button>
        </div>
        <HostAccessControl />
        <label class="check-row">
          <input
            :checked="autoFilterBrowserHeaders"
            type="checkbox"
            @change="
              emit(
                'update:autoFilterBrowserHeaders',
                ($event.target as HTMLInputElement).checked,
              )
            "
          />
          {{ $t("autoFilterBrowserHeaders") }}
        </label>
        <span class="empty-note">{{ $t("autoFilterBrowserHeadersHint") }}</span>
        <label class="check-row">
          <input
            :checked="persistSensitive"
            type="checkbox"
            @change="
              emit(
                'update:persistSensitive',
                ($event.target as HTMLInputElement).checked,
              )
            "
          />
          {{ $t("persistSensitive") }}
        </label>
      </div>
    </div>
  </section>
</template>
