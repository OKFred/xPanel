<script setup lang="ts">
import { onMounted, ref } from "vue";

const nativeStatus = ref<"optional" | "checking" | "connected" | "unavailable">(
  "optional",
);

function checkNativeHost(): Promise<boolean> {
  return new Promise((resolve) => {
    const port = chrome.runtime.connectNative("com.okfred.xpanel");
    const timeout = window.setTimeout(() => {
      port.disconnect();
      resolve(false);
    }, 1500);
    port.onMessage.addListener((message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "hello"
      ) {
        window.clearTimeout(timeout);
        port.disconnect();
        resolve(true);
      }
    });
    port.onDisconnect.addListener(() => {
      window.clearTimeout(timeout);
      resolve(false);
    });
    port.postMessage({
      version: 1,
      id: crypto.randomUUID(),
      type: "hello",
      client: { name: "xpanel-popup", version: "2.0.0" },
      capabilities: [],
    });
  });
}

onMounted(async () => {
  if (
    !(await chrome.permissions.contains({ permissions: ["nativeMessaging"] }))
  )
    return;
  nativeStatus.value = "checking";
  nativeStatus.value = (await checkNativeHost()) ? "connected" : "unavailable";
});
</script>

<template>
  <main class="popup-shell">
    <div class="brand-mark">x</div>
    <div>
      <h1>xPanel 2.0</h1>
      <p>{{ $t("openDevtools") }}</p>
      <span class="status-pill" :data-active="nativeStatus === 'connected'">
        {{ $t("nativeHost") }} {{ $t(nativeStatus) }}
      </span>
    </div>
  </main>
</template>
