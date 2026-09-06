<script setup lang="ts">
import { LoaderCircle, Trash2, X } from "lucide-vue-next";

import AppDialog from "./AppDialog.vue";
import type { DeleteTarget } from "./delete-target";

defineProps<{
  target: DeleteTarget;
  deleteCollectionRequests: boolean;
  busy: boolean;
  operationBusy: boolean;
  error: string;
}>();
const emit = defineEmits<{
  close: [];
  confirm: [];
  "update:deleteCollectionRequests": [value: boolean];
}>();
</script>

<template>
  <AppDialog
    role="alertdialog"
    card-class="confirm-dialog"
    labelled-by="delete-dialog-title"
    described-by="delete-dialog-description"
    :busy="busy || operationBusy"
    @close="emit('close')"
  >
    <header>
      <div>
        <span class="eyebrow">{{ $t("permanentAction") }}</span>
        <h2 id="delete-dialog-title">
          {{
            target.kind === "request"
              ? $t("deleteRequestTitle")
              : $t("deleteCollectionTitle")
          }}
        </h2>
      </div>
      <button
        class="icon-button"
        type="button"
        :disabled="busy || operationBusy"
        :aria-label="$t('closeDialog')"
        @click="emit('close')"
      >
        <X :size="18" />
      </button>
    </header>
    <div class="confirmation-content">
      <p id="delete-dialog-description">
        {{
          target.kind === "request"
            ? $t("deleteRequestDescription", { name: target.name })
            : $t("deleteCollectionDescription", {
                name: target.name,
                count: target.requestCount,
              })
        }}
      </p>
      <label
        v-if="target.kind === 'collection' && target.exclusiveRequestCount > 0"
        class="check-row cascade-delete"
      >
        <input
          :checked="deleteCollectionRequests"
          type="checkbox"
          :disabled="busy || operationBusy"
          @change="
            emit(
              'update:deleteCollectionRequests',
              ($event.target as HTMLInputElement).checked,
            )
          "
        />
        <span>
          {{
            $t("deleteCollectionRequests", {
              count: target.exclusiveRequestCount,
            })
          }}
        </span>
      </label>
      <p
        v-if="target.kind === 'collection' && deleteCollectionRequests"
        class="destructive-warning"
      >
        {{
          $t("deleteCollectionCascadeWarning", {
            exclusive: target.exclusiveRequestCount,
            shared: target.sharedRequestCount,
          })
        }}
      </p>
      <p class="destructive-warning">{{ $t("cannotUndo") }}</p>
      <p v-if="error" class="dialog-error" role="alert">{{ error }}</p>
    </div>
    <footer>
      <button
        class="ghost-button"
        type="button"
        data-dialog-initial-focus
        :disabled="busy || operationBusy"
        @click="emit('close')"
      >
        {{ $t("cancel") }}
      </button>
      <button
        class="danger-button"
        type="button"
        :disabled="busy || operationBusy"
        @click="emit('confirm')"
      >
        <LoaderCircle v-if="operationBusy" class="spin" :size="15" />
        <Trash2 v-else :size="15" /> {{ $t("delete") }}
      </button>
    </footer>
  </AppDialog>
</template>
