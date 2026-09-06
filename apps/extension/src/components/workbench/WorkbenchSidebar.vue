<script setup lang="ts">
import {
  Folder,
  Heart,
  Languages,
  PanelLeft,
  Plus,
  Trash2,
} from "lucide-vue-next";

import type { CollectionRecord, RequestSpecV1 } from "@xpanel/contracts";

import { Button } from "../ui/button";

defineProps<{
  collections: CollectionRecord[];
  requests: RequestSpecV1[];
  favorites: RequestSpecV1[];
  currentId: string;
  busy: boolean;
  deleteBusy: boolean;
  surface: "devtools" | "standalone";
  displayCollectionName: (collection: CollectionRecord) => string;
}>();

const emit = defineEmits<{
  createRequest: [];
  createCollection: [];
  load: [request: RequestSpecV1, collectionId?: string];
  deleteRequest: [request: RequestSpecV1];
  deleteCollection: [collection: CollectionRecord];
  toggleLocale: [];
}>();
</script>

<template>
  <aside class="sidebar">
    <div class="brand-row">
      <div class="brand-mark">x</div>
      <div>
        <strong>xPanel</strong><span>{{ $t("localFirst") }}</span>
      </div>
    </div>
    <Button
      class="w-full"
      type="button"
      :disabled="busy"
      @click="emit('createRequest')"
    >
      <Plus :size="16" /> {{ $t("newRequest") }}
    </Button>
    <section class="sidebar-section">
      <h2>
        <span><Folder :size="15" /> {{ $t("collections") }}</span>
        <button
          class="icon-button"
          type="button"
          :disabled="busy"
          :aria-label="$t('newCollection')"
          @click="emit('createCollection')"
        >
          <Plus :size="14" />
        </button>
      </h2>
      <div
        v-for="collection in collections"
        :key="collection.id"
        class="collection-group"
      >
        <div class="collection-heading">
          <div class="collection-name">
            {{ displayCollectionName(collection) }}
          </div>
          <button
            class="icon-button delete-icon"
            type="button"
            :disabled="busy || deleteBusy"
            :aria-label="
              $t('deleteCollectionLabel', {
                name: displayCollectionName(collection),
              })
            "
            @click.stop="emit('deleteCollection', collection)"
          >
            <Trash2 :size="13" />
          </button>
        </div>
        <div
          v-for="request in requests.filter((item) =>
            collection.requestIds.includes(item.id),
          )"
          :key="request.id"
          class="request-link-row"
          :data-active="request.id === currentId"
        >
          <button
            class="request-link"
            type="button"
            :disabled="busy || deleteBusy"
            @click="emit('load', request, collection.id)"
          >
            <span class="method-mini">{{ request.method }}</span
            ><span>{{ request.name }}</span>
          </button>
          <button
            class="icon-button delete-icon"
            type="button"
            :disabled="busy || deleteBusy"
            :aria-label="$t('deleteRequestLabel', { name: request.name })"
            @click.stop="emit('deleteRequest', request)"
          >
            <Trash2 :size="13" />
          </button>
        </div>
      </div>
    </section>
    <section class="sidebar-section favorites">
      <h2><Heart :size="15" /> {{ $t("favorites") }}</h2>
      <div
        v-for="request in favorites"
        :key="request.id"
        class="request-link-row"
      >
        <button
          class="request-link"
          type="button"
          :disabled="busy || deleteBusy"
          @click="emit('load', request)"
        >
          <span class="method-mini">{{ request.method }}</span
          ><span>{{ request.name }}</span>
        </button>
        <button
          class="icon-button delete-icon"
          type="button"
          :disabled="busy || deleteBusy"
          :aria-label="$t('deleteRequestLabel', { name: request.name })"
          @click.stop="emit('deleteRequest', request)"
        >
          <Trash2 :size="13" />
        </button>
      </div>
      <p v-if="favorites.length === 0" class="empty-note">
        {{ $t("noFavorites") }}
      </p>
    </section>
    <div class="sidebar-footer">
      <span
        ><PanelLeft :size="14" />
        {{
          $t(surface === "devtools" ? "devtoolsPanel" : "standaloneWorkbench")
        }}</span
      >
      <button
        class="icon-button"
        type="button"
        :aria-label="$t('switchLanguage')"
        @click="emit('toggleLocale')"
      >
        <Languages :size="16" />
      </button>
    </div>
  </aside>
</template>
