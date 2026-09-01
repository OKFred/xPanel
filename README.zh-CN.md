# xPanel 2.0

xPanel 是运行在 Chrome DevTools 内的本地优先 API 客户端。2.0 版本使用 WXT、
Vue 3、shadcn-vue/Tailwind 完成 Manifest V3 重写，并提供请求集合、安全导入导出、响应检查，以及可选的本机
伴侣来处理浏览器 Fetch 无法完整表达的请求。

## 主要能力

- 继续使用 DevTools 的 **xPanel** 页签，无账号、无托管后端。
- Browser 与 Native 两种执行模式，权限均在实际使用时明确申请。
- 双向支持 cURL（Bash）、PowerShell、Node.js fetch、HAR 1.2、OpenAPI 3.x、
  Swagger 2.0 和无损 xPanel 集合格式。
- 支持集合、收藏、JSON 美化/压缩及一键复制。
- 中英文界面。
- 本机宿主不会执行粘贴脚本；它只验证结构化请求，并在无 shell 模式下调用 cURL。

## 开发

需要 Node.js 24、pnpm 11、Chrome 120+；Native Host 测试还需要 cURL。

```bash
pnpm install
pnpm --filter @xpanel/extension dev
pnpm check
```

在 `chrome://extensions` 加载
`apps/extension/.output/chrome-mv3-dev`，打开 DevTools 后选择 xPanel。
本机宿主安装见 [docs/native-host.md](docs/native-host.md)。

隐私、权限及升级边界分别见 [隐私说明](docs/privacy.md)、
[权限说明](docs/permissions.md) 和 [2.0 迁移说明](docs/migration-2.0.md)。
