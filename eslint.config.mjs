import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import pluginVue from "eslint-plugin-vue";
import tseslint from "typescript-eslint";
import vueParser from "vue-eslint-parser";

const typeCheckedConfigs = tseslint.configs.recommendedTypeChecked.map(
  (config) => ({
    ...config,
    files: ["**/*.{ts,tsx,vue}"],
  }),
);

export default tseslint.config(
  {
    ignores: [
      "**/.output/**",
      "**/.wxt/**",
      "**/coverage/**",
      "**/dist/**",
      "**/node_modules/**",
      "**/worker-configuration.d.ts",
      "artifacts/**",
      "legacy/**",
    ],
  },
  eslint.configs.recommended,
  ...typeCheckedConfigs,
  ...pluginVue.configs["flat/recommended"],
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    files: ["**/*.vue"],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        extraFileExtensions: [".vue"],
        parser: tseslint.parser,
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    files: ["**/test/**/*.ts", "**/tests/**/*.ts"],
    rules: {
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    files: ["**/entrypoints/*/main.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-argument": "off",
    },
  },
  {
    files: ["**/*.mjs"],
    languageOptions: {
      globals: {
        AbortController: "readonly",
        Buffer: "readonly",
        DOMException: "readonly",
        Headers: "readonly",
        ReadableStream: "readonly",
        Response: "readonly",
        TextEncoder: "readonly",
        URL: "readonly",
        WebSocket: "readonly",
        btoa: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        crypto: "readonly",
        fetch: "readonly",
        performance: "readonly",
        process: "readonly",
        setTimeout: "readonly",
      },
    },
  },
  prettier,
);
