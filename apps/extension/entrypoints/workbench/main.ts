import { createPinia } from "pinia";
import { createApp } from "vue";

import App from "./App.vue";
import { i18n } from "../../src/i18n";
import { router } from "../../src/router";
import "../../src/styles.css";

createApp(App).use(createPinia()).use(router).use(i18n).mount("#app");
