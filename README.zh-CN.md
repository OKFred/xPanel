# xPanel 3.0.1

xPanel 是可独立打开、也可运行在 Chrome DevTools 内的本地优先 API 工作台。3.0.0
使用用户自行配置的 [one-fetch 0.1.2 Preview](https://github.com/OKFred/one-fetch/releases/tag/v0.1.2)
替代旧 Remote Relay，保留 Browser Fetch、后台执行、集合、格式转换和虚拟响应查看器。

3.0.1 修复空白或无效 URL 导出时的报错，保留未完成请求的集合备份能力，并防止失败或过期的导出预览被复制、下载。详见[修复说明](docs/release-3.0.1.md)。

## 主要能力

- 可使用独立工作台或 DevTools 的 **xPanel** 页签；只有 DevTools 页面能导入当前标签页的 Network HAR。
- 用户主动发起的请求由临时 offscreen 扩展文档执行，因此关闭工作台页面后仍可继续；暂存输入会在运行终止时删除，本地结果默认保留 10 分钟。
- 使用 Browser Fetch 执行；默认按目标站点精确申请权限，也可由用户主动一次授权全部 HTTP/HTTPS 站点，随时恢复逐域询问。
- 可显式选择多个命名 one-fetch Profile，分别配置 Control URL、Gateway URL 和 execution Token。Remote 只需授权服务站点，不逐个请求目标域名权限；xPanel 绝不静默切换或远程发送。
- Token 默认只保留当前 Chrome 会话；明文持久保存需要额外确认。每个 Profile 可设置只增加拒绝规则的用户黑名单，不能覆盖管理员策略。
- 分开展示目标响应、服务错误和未经验证的中间层响应；HTTP 4xx/5xx 不用于猜测响应来源。正文完整性独立校验，缺少最终报告时明确显示未核验。
- 目标与外层服务 Headers、目标 Server-Timing 与 Gateway 耗时分别显示。多条 Set-Cookie 保持独立，不写入浏览器 Cookie jar；Remote 只发送显式 Cookie。
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
pnpm check
pnpm e2e:chromium
pnpm e2e:upgrade
```

Chromium E2E 使用隔离的临时 Profile 和已安装的 Chromium/Chrome for Testing；
无法自动发现时可设置 `XPANEL_CHROMIUM_EXECUTABLE`。
`node scripts/e2e-chromium.mjs --one-fetch-node` 使用摘要校验后的正式 Node 归档及隔离的 Docker 容器。
在线验收通过 `--one-fetch-cloudflare` 或 `--one-fetch-supabase` 显式启用，需要精确匹配
v0.1.2 的干净 one-fetch 相邻仓库、已登录的 CLI，以及创建和删除临时合成资源的授权。
不使用 media-center，不保留公共 Gateway。脱敏记录位于 `artifacts/one-fetch-e2e`。

在 `chrome://extensions` 加载 `apps/extension/.output/chrome-mv3-dev`。可从扩展
按钮进入独立工作台，也可打开 DevTools 后选择 xPanel。

服务配置与限制见 [one-fetch 接入说明](docs/one-fetch.md)。Remote 请求只有在用户
显式选择并确认后才会经过自建服务，请求 URL、Headers、凭据和正文都会离开本机。
后台执行不会创建或定时发起请求：Service Worker 与 offscreen 文档只继续用户主动
开始的工作，alarms 仅用于清理到期的本地执行数据。

隐私、权限及升级边界分别见 [隐私说明](docs/privacy.md)、
[权限说明](docs/permissions.md) 和 [2.0 迁移说明](docs/migration-2.0.md)。

3.0 升级说明见 [docs/migration-3.0.md](docs/migration-3.0.md)。旧 Relay Profile 保留为停用只读状态，
不会猜测新地址或复用旧 Token；用户确认后才删除旧配置。原集合、收藏及结果保留。
本版仅支持 HTTP，不包含 Native、插件内账号登录、代理或隧道。

GitHub Actions 不会
上传、提审或发布 Chrome Web Store 更新。审核过的提交进入 `main` 且发布门禁通过
后，维护者仍需手动上传，并在提审时关闭自动发布；审核通过后，更新进入 staged
状态，须在 30 天内另行手动发布。
