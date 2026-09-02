# xPanel 2.0

xPanel 是运行在 Chrome DevTools 内的本地优先 API 客户端。2.0 版本使用 WXT、
Vue 3、shadcn-vue/Tailwind 完成 Manifest V3 重写，并提供请求集合、安全导入导出、
响应检查和 Browser Fetch 执行。

## 主要能力

- 继续使用 DevTools 的 **xPanel** 页签，无账号、无托管后端。
- 使用 Browser Fetch 执行，并在发送时按目标站点精确申请权限。
- 每个请求都可单独设置超时时间，默认 60 秒。
- 双向支持 cURL（Bash）、PowerShell、Node.js fetch、HAR 1.2、OpenAPI 3.x、
  Swagger 2.0 和无损 xPanel 集合格式。
- 支持集合、收藏、JSON 美化/压缩及一键复制。
- 中英文界面。
- 导入命令只做静态解析，绝不执行粘贴的 Bash、PowerShell 或 JavaScript。

## 开发

需要 Node.js 24、pnpm 11 和 Chrome 120+。

```bash
pnpm install
pnpm --filter @xpanel/extension dev
pnpm check
```

在 `chrome://extensions` 加载
`apps/extension/.output/chrome-mv3-dev`，打开 DevTools 后选择 xPanel。

隐私、权限及升级边界分别见 [隐私说明](docs/privacy.md)、
[权限说明](docs/permissions.md) 和 [2.0 迁移说明](docs/migration-2.0.md)。
