import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "wxt";

export default defineConfig({
  manifestVersion: 3,
  modules: ["@wxt-dev/module-vue"],
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: {
    name: "__MSG_extensionName__",
    description: "__MSG_extensionDescription__",
    default_locale: "zh_CN",
    version: "2.0.0",
    minimum_chrome_version: "120",
    permissions: ["storage"],
    optional_host_permissions: ["http://*/*", "https://*/*"],
    action: {
      default_title: "__MSG_extensionName__",
      default_popup: "popup.html",
    },
    icons: {
      "48": "icon/128.png",
      "128": "icon/128.png",
    },
  },
});
