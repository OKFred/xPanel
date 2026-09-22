<script setup lang="ts">
import type { OneFetchCapabilitiesV1 } from "@one-fetch/protocol";
defineProps<{ capabilities: OneFetchCapabilitiesV1 }>();
</script>
<template>
  <details class="one-fetch-capabilities">
    <summary>
      {{ capabilities.provider }} · {{ capabilities.buildVersion }} ·
      {{ $t("oneFetchConfigVersion") }} {{ capabilities.configVersion }} ·
      {{ capabilities.configUpdatedAt }}
    </summary>
    <p>{{ $t("oneFetchCapabilityNotice") }}</p>
    <p>
      {{ $t("oneFetchPolicyMode") }}: {{ capabilities.policyMode }} ·
      {{ $t("oneFetchAudit") }}: {{ capabilities.audit.state }}
    </p>
    <p>{{ $t("oneFetchEmptyAllowlist") }}</p>
    <p>{{ $t("oneFetchTimingUnavailable") }}</p>
    <ul>
      <li
        v-for="(mutation, index) in capabilities.headerMutations"
        :key="index"
      >
        {{ mutation.side }} · {{ mutation.name }}: {{ mutation.detail }}
      </li>
    </ul>
    <ul>
      <li v-for="option in capabilities.fetchOptions" :key="option.option">
        {{ option.option }}: {{ option.fidelity }} {{ option.detail }}
      </li>
    </ul>
  </details>
</template>
<style scoped>
.one-fetch-capabilities {
  max-height: 180px;
  overflow: auto;
  font-size: 12px;
  padding: 8px;
  overflow-wrap: anywhere;
}
summary {
  cursor: pointer;
}
</style>
