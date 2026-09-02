# xPanel 2.0

xPanel 是运行在 Chrome DevTools 内的本地优先 API 客户端。2.0 版本使用 WXT、
Vue 3、shadcn-vue/Tailwind 完成 Manifest V3 重写，并提供请求集合、安全导入导出、
响应检查、Browser Fetch 执行和可选的自托管 Remote Relay。

## 主要能力

- 继续使用 DevTools 的 **xPanel** 页签，无 xPanel 账号，也没有 xPanel 运营的后端。
- 使用 Browser Fetch 执行，并在发送时按目标站点精确申请权限。
- 可显式选择多个命名 Remote Relay，用于浏览器无法原样表达的请求；xPanel 绝不静默切换或远程发送。
- 每个请求都可单独设置超时时间，默认 60 秒。
- Browser 与 Remote 共用真实阶段进度和停止按钮；响应正文使用流式下载进度。
- 双向支持 cURL（Bash）、PowerShell、Node.js fetch、HAR 1.2、OpenAPI 3.x、
  Swagger 2.0 和无损 xPanel 集合格式。
- 支持集合、收藏及带确认的安全删除、JSON 美化/压缩和一键复制。
- 中英文界面。
- 导入命令只做静态解析，绝不执行粘贴的 Bash、PowerShell 或 JavaScript。

## 开发

需要 Node.js 24、pnpm 11 和 Chrome 120+。

```bash
pnpm install
pnpm --filter @xpanel/extension dev
pnpm --filter @xpanel/relay-cloudflare dev
pnpm check
pnpm e2e:chromium
```

Chromium E2E 使用隔离的临时 Profile 和已安装的 Chromium/Chrome for Testing；
无法自动发现时可设置 `XPANEL_CHROMIUM_EXECUTABLE`。可选在线 Relay 验收读取
`XPANEL_REMOTE_BASE_URL`、`XPANEL_REMOTE_TOKEN` 和
`XPANEL_REMOTE_TARGET_URL`，测试脚本不会输出 Token。协议在线套件应把合成
Fixture 的 origin 作为 target；Chromium E2E 则应传 Fixture 的具体 `/e2e` URL。

在 `chrome://extensions` 加载
`apps/extension/.output/chrome-mv3-dev`，打开 DevTools 后选择 xPanel。

Cloudflare Relay 的自托管说明见
[apps/relay-cloudflare/README.md](apps/relay-cloudflare/README.md)。Remote 请求只有在用户
显式选择并确认后才会经过自建服务，请求 URL、Headers、凭据和正文都会离开本机。

隐私、权限及升级边界分别见 [隐私说明](docs/privacy.md)、
[权限说明](docs/permissions.md) 和 [2.0 迁移说明](docs/migration-2.0.md)。
