# Chrome Web Store submission kit for xPanel 2.1.0

This document contains the proposed material and release checklist for updating
the existing item `diaemdialoooebdennhpgnmobnjabohm`. It does not authorize
upload, submission, or publication; all three remain manual
developer-dashboard actions.

## Yellow Argon resubmission

The 7 September 2026 review rejected only the localized listing descriptions
for excessive format keywords (`Yellow Argon`). Keep the already uploaded
2.1.0 package, edit both descriptions using the copy below, and resubmit the
draft without appealing. Do not upload the unchanged ZIP again or increment the
extension version for this metadata-only correction.

## Publishing mode

Use [deferred publishing](https://developer.chrome.com/docs/webstore/update#deferred-publishing)
for this update. In the review-confirmation dialog, clear the option that
publishes automatically after approval. A successful review should leave 2.1.0
staged until a maintainer inspects it and explicitly publishes it. Chrome Web
Store allows up to 30 days to publish an approved staged submission; after that
it returns to draft and must be reviewed again.

## URLs and classification

- Category: Developer Tools
- Homepage: <https://github.com/okfred>
- Support: <https://github.com/OKFred/xPanel/issues>
- Privacy policy:
  <https://github.com/OKFred/xPanel/blob/main/docs/privacy.md>
- Primary locale: Chinese (Simplified)
- Additional locale: English

`Official URL` is separate from the Manifest and listing homepage. Leave it
unset unless the publisher account has a suitable Search Console-verified site;
`homepage_url` does not populate that verified-site selector.

Keep these `main` URLs in the dashboard so the listing does not depend on a
temporary development branch.

## English listing

### Summary

xPanel is a local-first API workbench for standalone and Chrome DevTools use,
with safe imports and optional self-hosted relays.

### Detailed description

xPanel provides the same focused API request and response workbench as a
standalone extension page and in Chrome DevTools. Browser mode sends requests
directly from the extension after you approve the target origin. Exact-origin
approval is the default; Request Options also offers an explicit one-time
all-HTTP/HTTPS grant for users who regularly switch API domains. An optional
Remote Relay profile can replay requests that Browser Fetch cannot faithfully
express, but xPanel never selects a relay or sends data remotely without your
explicit choice and confirmation.

Key features:

- Build HTTP requests with parameters, authentication, headers, and common
  body types.
- Inspect response content and metadata, including redirects and returned
  cookies.
- Bring requests in from common developer-tool exports and API documents, then
  export reusable collections.
- Save collections and favorites locally, format JSON, copy results quickly,
  and cancel active requests.
- Continue a request the user started if the standalone page or DevTools panel
  closes, then make its temporary local result available when a workbench
  reopens. Results expire after ten minutes by default; users may instead
  choose one hour, the current Chrome session, or retention until manual
  cleanup. Manual retention requires an additional sensitive-data warning.
- Use a 60-second default timeout with visible request phases and real download
  progress when the response size is known.
- Optionally connect to a relay that you deploy and trust. xPanel provides no
  public proxy and operates no backend.

xPanel contains no analytics, advertising, account system, or telemetry.
Persistent request saves and exports are sanitized unless you explicitly
include sensitive data. A full request is staged locally only while completing
the execution you started.

Version 2.0 replaced the former Manifest V2 localhost CORS modification with a
Manifest V3 implementation and user-controlled optional host access. Version
2.1.0 adds the standalone workbench and extension-managed background execution.

## Chinese (Simplified) listing

### Summary

xPanel 是可独立打开、也可在 Chrome DevTools 中使用的本地优先 API 工作台，支持安全导入与可选的自托管 Relay。

### Detailed description

xPanel 既提供独立扩展页面，也保留 Chrome DevTools 内的 API 请求与响应工作台。Browser 模式会在你批准目标站点后直接从扩展发起请求；默认逐域批准，也可以在请求选项中主动一次授权全部 HTTP/HTTPS 站点，并随时清除授权恢复逐域询问。对于 Browser Fetch 无法准确表达的请求，可以显式选择自己部署并信任的 Remote Relay；xPanel 不会自动切换执行器，也不会在未经确认时把数据发送给 Relay。

主要功能：

- 构建包含参数、认证、请求头和常见正文类型的 HTTP 请求。
- 检查响应内容与元数据，包括重定向和返回的 Cookie。
- 从常见开发工具导出内容和接口文档中导入请求，并导出为可复用集合。
- 在本地保存集合和收藏，快速美化 JSON、复制结果并中止请求。
- 独立页面或 DevTools 面板关闭后，仍可继续完成用户主动发起的请求；重新打开工作台即可读取临时本地结果。默认保留 10 分钟，也可选择 1 小时、当前 Chrome 会话或手动清理；手动保留会再次提示敏感数据风险。
- 默认超时 60 秒，显示真实请求阶段；响应大小已知时显示下载百分比。
- 可选连接由用户自行部署并信任的 Relay；xPanel 不提供公共代理，也不运营后端。

xPanel 不包含统计分析、广告、账号系统或遥测。敏感值默认仅保留在会话中，导出默认脱敏，只有用户明确选择时才包含敏感数据。

2.0 版以 Manifest V3 和由用户控制的可选站点授权，替代旧版 Manifest V2 的 localhost CORS 修改功能；2.1.0 新增独立工作台和由扩展管理的后台执行。

## Privacy practices

### Single purpose

Provide a local-first API request and response workbench as a standalone
extension page and inside Chrome DevTools.

### Permission justifications

| Dashboard field                                  | Text to enter                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                                        | Stores user-created request drafts, collections, favorites, preferences, and Relay profile metadata locally. Relay secrets use `chrome.storage.session` by default; persisting a Relay token requires a separate user confirmation.                                                                                                                                                                                                |
| `offscreen`                                      | Creates a temporary extension document using the `WORKERS` and `BLOBS` reasons so a request explicitly started by the user can continue independently of a visible workbench, including streaming and locally storing its result. It does not read unrelated pages or capture audio.                                                                                                                                               |
| `alarms`                                         | Schedules cleanup of expired extension-local execution records and results. Alarms never start network requests.                                                                                                                                                                                                                                                                                                                   |
| `http://*/*`, `https://*/*` optional host access | By default, xPanel asks only for the exact origin entered by the user so Browser mode can perform that request, resolve an approved external OpenAPI reference, or contact a configured Relay. In Request Options, the user may explicitly grant both optional wildcard ranges once to avoid prompts when switching domains, and can clear those grants to restore per-domain prompts. No host access is required at install time. |

### Remote code

Select **No, I am not using remote code**.

xPanel neither downloads nor evaluates executable code. Remote Relay exchanges
strictly validated request and response data using the versioned Relay V1
protocol. Imported Bash, PowerShell, and JavaScript text is parsed as static
data and is never executed.

### Data categories and use

Disclose the following categories because Chrome Web Store disclosure applies
even when data remains on the device:

| Category                        | Why xPanel handles it                                                                                                                                                                                                                                                                                     | Use                     |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Authentication information      | User-entered Authorization, Cookie, API-key, and Relay-token values may be part of a request.                                                                                                                                                                                                             | App functionality only. |
| Web history / browsing activity | Request URLs and DevTools Network HAR entries identify resources the user chooses to inspect or replay.                                                                                                                                                                                                   | App functionality only. |
| Website content                 | Request and response bodies, headers, OpenAPI documents, and HAR content are displayed or transformed at the user's direction. Execution results expire after ten minutes by default; the user may choose one hour, the current Chrome session, or manual retention. Explicit saves remain until deleted. | App functionality only. |
| User-generated content          | Request drafts, bodies, collections, names, and imported documents are created or selected by the user.                                                                                                                                                                                                   | App functionality only. |

Certify that data is not sold, is not used for advertising, creditworthiness,
or unrelated purposes, and is not transferred except as required to perform the
user-selected request. Browser traffic goes to the selected destination. Remote
traffic goes to the user-selected self-hosted Relay and then the destination,
only after an in-product disclosure and confirmation. No request data is sent
to the xPanel developer.

## Reviewer instructions

1. Install version 2.1.0 and open the standalone workbench from the extension
   action. No DevTools window is required.
2. In the default **Browser** executor, enter a public test API URL and click
   **Send**. Approve the exact origin when Chrome asks. No account or test
   credential is required.
   Optionally open Request Options and verify that **Allow all sites once** asks
   once for both HTTP/HTTPS wildcard ranges, while **Clear access and ask per
   domain** restores exact-origin prompts.
3. Start a delayed request, close the workbench, and reopen it. Verify that the
   user-started request continued and its temporary local result is available.
4. Verify the response Pretty/Raw/Headers/Timing tabs, copy actions, 60-second
   default timeout under Options, progress bar, and Stop button.
5. Open Import and use a static cURL request. Then open Chrome DevTools, select
   the **xPanel** tab, and verify that Current Network HAR is available only
   there. Imported scripts are parsed and never executed.
6. Open the executor's Relay manager to inspect optional Remote Relay profiles.
   xPanel does not operate or bundle a Relay endpoint. Users must explicitly
   configure a service they deploy and trust, select it, and confirm the data
   disclosure before the first Remote send in each Chrome session. Browser
   remains the default after restart.

## Graphic assets

- English screenshots: [`assets/en`](assets/en)
- Chinese screenshots: [`assets/zh_CN`](assets/zh_CN)
- Store icon and small promo tile: [`assets/global`](assets/global)

Regenerate and review all localized screenshots from the unpacked 2.1.0 build
before upload. Include the standalone workbench and the DevTools-only Network
HAR distinction in the reviewed set. Screenshots are 1280x800, the promo tile
is 440x280, and the store icon is 128x128.

## Final dashboard checklist

- For the `Yellow Argon` metadata resubmission, keep the existing uploaded
  2.1.0 package and confirm that neither rejected keyword list remains in the
  localized descriptions.
- Upload `xpanelextension-2.1.0-chrome.zip` only when creating the original
  2.1.0 draft or when the dashboard no longer retains that package.
- Paste the localized listing copy and replace all outdated Manifest V2 images.
- Upload the 128x128 icon, three screenshots per locale, and 440x280 promo tile.
- Complete every Privacy practices field using the text above.
- Confirm distribution settings and that no outdated localhost CORS claim
  remains visible.
- Save the draft and review the public preview.
- Submit for review manually. In the confirmation dialog, clear **Publish
  automatically** so the approved update remains staged. Do not select any
  expedited DNR-only review path.
- After approval, inspect the staged item and publish it manually within 30
  days, or allow it to return to draft for a new review.
