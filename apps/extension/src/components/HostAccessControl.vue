<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";

import {
  grantAllHttpHostAccess,
  hasAllHttpHostAccess,
  revokeAllHttpHostAccess,
} from "../lib/host-access";

const { t } = useI18n();
const allSitesGranted = ref(false);
const busy = ref(false);
const message = ref("");
const failed = ref(false);
let refreshVersion = 0;

async function refreshAccess(): Promise<void> {
  const version = ++refreshVersion;
  try {
    const granted = await hasAllHttpHostAccess();
    if (version === refreshVersion && !busy.value) {
      allSitesGranted.value = granted;
    }
  } catch {
    if (version === refreshVersion && !busy.value) {
      allSitesGranted.value = false;
    }
  }
}

function handleWindowFocus(): void {
  void refreshAccess();
}

async function grantAccess(): Promise<void> {
  busy.value = true;
  refreshVersion += 1;
  message.value = "";
  failed.value = false;
  try {
    // Keep this as the first asynchronous Chrome API call in the click chain.
    const granted = await grantAllHttpHostAccess();
    allSitesGranted.value = granted;
    message.value = t(
      granted ? "allSitesAccessGranted" : "allSitesAccessDenied",
    );
    failed.value = !granted;
  } catch (error) {
    failed.value = true;
    message.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
  }
}

async function revokeAccess(): Promise<void> {
  busy.value = true;
  refreshVersion += 1;
  message.value = "";
  failed.value = false;
  try {
    const removed = await revokeAllHttpHostAccess();
    if (!removed) throw new Error(t("siteAccessRevokeFailed"));
    allSitesGranted.value = false;
    message.value = t("siteAccessRevoked");
  } catch (error) {
    failed.value = true;
    message.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
  }
}

onMounted(() => {
  void refreshAccess();
  window.addEventListener("focus", handleWindowFocus);
});

onBeforeUnmount(() => window.removeEventListener("focus", handleWindowFocus));
</script>

<template>
  <div class="host-access-control" data-testid="host-access-control">
    <div class="host-access-heading">
      <strong>{{ $t("browserSiteAccess") }}</strong>
      <span
        class="host-access-status"
        :data-granted="allSitesGranted"
        aria-live="polite"
      >
        {{ $t(allSitesGranted ? "siteAccessAllSites" : "siteAccessPerDomain") }}
      </span>
    </div>
    <p id="xpanel-host-access-hint" class="host-access-hint">
      {{
        $t(
          allSitesGranted
            ? "allSitesAccessActiveHint"
            : "allSitesAccessOfferHint",
        )
      }}
    </p>
    <button
      class="ghost-button host-access-action"
      type="button"
      :disabled="busy"
      aria-describedby="xpanel-host-access-hint"
      @click="allSitesGranted ? revokeAccess() : grantAccess()"
    >
      {{
        $t(
          busy
            ? "siteAccessWorking"
            : allSitesGranted
              ? "revokeAllSitesAccess"
              : "grantAllSitesAccess",
        )
      }}
    </button>
    <p
      v-if="message"
      class="host-access-message"
      :data-error="failed"
      :role="failed ? 'alert' : 'status'"
      aria-live="polite"
    >
      {{ message }}
    </p>
  </div>
</template>

<style scoped>
.host-access-control {
  display: grid;
  gap: 0.45rem;
  padding: 0.75rem;
  border: 1px solid #27354a;
  border-radius: 0.6rem;
  background: #0c1422;
}

.host-access-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.host-access-status {
  color: #8090aa;
  font-size: 0.78rem;
}

.host-access-status[data-granted="true"] {
  color: #7de4bd;
}

.host-access-hint,
.host-access-message {
  margin: 0;
  color: #8090aa;
  font-size: 0.78rem;
  line-height: 1.45;
}

.host-access-message[data-error="true"] {
  color: #ff9ba8;
}

.host-access-action {
  justify-self: start;
}
</style>
