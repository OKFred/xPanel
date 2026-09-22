<script setup lang="ts">
import type { OneFetchResponseDetailsV1 } from "@xpanel/contracts";
import { computed } from "vue";
const props = defineProps<{
  details: OneFetchResponseDetailsV1;
  tab: string;
}>();
const phases = computed(() => {
  const reported = props.details.timing?.phases ?? [];
  return [
    ...reported,
    ...["dns", "connect", "tls", "ttfb", "download"]
      .filter(
        (name) =>
          !reported.some(
            (phase) => phase.name === name && phase.source === "gateway",
          ),
      )
      .map((name) => ({
        name,
        source: "gateway",
        state: "unavailable",
        durationMs: undefined,
      })),
  ];
});
</script>
<template>
  <div class="one-fetch-result" :data-source="details.source">
    <strong>{{
      $t(
        details.source === "target"
          ? "oneFetchTarget"
          : details.source === "relay-error"
            ? "oneFetchRelayError"
            : "oneFetchIntermediary",
      )
    }}</strong>
    <span>
      · {{ $t("oneFetchIntegrity") }}:
      {{
        $t(
          details.integrity === "verified"
            ? "oneFetchVerified"
            : details.integrity === "failed"
              ? "oneFetchFailed"
              : "oneFetchUnverified",
        )
      }}</span
    >
    <p v-if="details.configVersion">
      {{ $t("oneFetchConfigVersion") }}: {{ details.configVersion }} ·
      {{ $t("oneFetchAudit") }}: {{ details.audit }}
    </p>
    <p v-if="details.problem">
      {{ details.problem.code }} · {{ details.problem.stage }}:
      {{ details.problem.message }}
    </p>
    <p v-if="details.reason">
      <span v-if="details.reason === 'report-digest-unavailable'"
        >{{ $t("oneFetchNoDigest") }}
      </span>
      {{ details.reason }}
    </p>
    <details v-if="tab === 'headers'">
      <summary>
        {{ $t("oneFetchOuterHeaders") }} · HTTP {{ details.outerStatus }}
      </summary>
      <pre>{{
        details.outerHeaders.map((h) => `${h.name}: ${h.value}`).join("\n")
      }}</pre>
    </details>
    <template v-if="tab === 'timing'">
      <strong>{{ $t("oneFetchGatewayTiming") }}</strong>
      <div v-for="phase in phases" :key="`${phase.source}-${phase.name}`">
        {{ phase.source }} /
        {{ phase.name === "connect" ? "tcp/connect" : phase.name }}:
        {{
          phase.durationMs === undefined
            ? $t("oneFetchUnavailable")
            : `${phase.durationMs.toFixed(2)} ms`
        }}
        ({{ phase.state }})
      </div>
      <p>{{ $t("oneFetchTimingUnavailable") }}</p>
      <strong>{{ $t("oneFetchTargetTiming") }}</strong>
      <div v-for="(metric, index) in details.timing?.serverTiming" :key="index">
        {{ metric.name }}:
        {{
          metric.durationMs === undefined
            ? $t("oneFetchUnavailable")
            : `${metric.durationMs} ms`
        }}
        {{ metric.description }}
      </div>
    </template>
  </div>
</template>
<style scoped>
.one-fetch-result {
  padding: 8px 12px;
  font-size: 12px;
  overflow: auto;
  max-height: 220px;
  overflow-wrap: anywhere;
  border-bottom: 1px solid var(--border);
}
pre {
  overflow: auto;
  white-space: pre;
}
[data-source="relay-error"],
[data-source="intermediary"] {
  color: #a44711;
}
</style>
