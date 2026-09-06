import { createI18n } from "vue-i18n";

import { enUS } from "./en-US";
import { zhCN } from "./zh-CN";

export const messages = {
  "zh-CN": zhCN,
  "en-US": enUS,
} as const;

const browserLocale = chrome.i18n.getUILanguage().toLowerCase().startsWith("zh")
  ? "zh-CN"
  : "en-US";

export const i18n = createI18n({
  legacy: false,
  locale: browserLocale,
  fallbackLocale: "en-US",
  messages,
});
