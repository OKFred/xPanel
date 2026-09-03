# Chrome Web Store submission kit for xPanel 2.0.0

This document contains the exact material for updating the existing item
`diaemdialoooebdennhpgnmobnjabohm`. It does not authorize publication. Upload
and final submission remain manual developer-dashboard actions.

## URLs and classification

- Category: Developer Tools
- Homepage:
  <https://github.com/OKFred/xPanel/tree/codex/refactor-mv3-devpanel>
- Support: <https://github.com/OKFred/xPanel/issues>
- Privacy policy:
  <https://github.com/OKFred/xPanel/blob/codex/refactor-mv3-devpanel/docs/privacy.md>
- Primary locale: Chinese (Simplified)
- Additional locale: English

Keep `codex/refactor-mv3-devpanel` public while any dashboard field references
it. After the release is merged, change the URLs to their `main` equivalents
before deleting this branch.

## English listing

### Summary

xPanel is a local-first API client for Chrome DevTools with collections,
imports, exports, and optional self-hosted relays.

### Detailed description

xPanel adds a focused API request and response workbench to Chrome DevTools.
Browser mode sends requests directly from the extension after you approve the
exact target origin. An optional Remote Relay profile can replay requests that
Browser Fetch cannot faithfully express, but xPanel never selects a relay or
sends data remotely without your explicit choice and confirmation.

Key features:

- Build requests with URL parameters, authentication, headers, JSON, text,
  URL-encoded, and multipart bodies.
- Inspect pretty or raw response bodies, headers, timing, redirects, and
  returned Set-Cookie values.
- Import and export cURL (Bash), PowerShell, Node fetch, HAR 1.2, OpenAPI 3,
  Swagger 2, and versioned xPanel collections.
- Save collections and favorites locally, format JSON, copy results quickly,
  and cancel active requests.
- Use a 60-second default timeout with visible request phases and real download
  progress when the response size is known.
- Optionally connect to a relay that you deploy and trust. xPanel provides no
  public proxy and operates no backend.

xPanel contains no analytics, advertising, account system, or telemetry.
Sensitive values are session-only by default, and exports are sanitized unless
you explicitly include sensitive data.

Version 2.0 replaces the former Manifest V2 localhost CORS modification with a
Manifest V3 implementation and exact optional host access.

## Chinese (Simplified) listing

### Summary

xPanel 是 Chrome DevTools 内的本地优先 API 客户端，支持集合、多格式导入导出与可选的自托管 Relay。

### Detailed description

xPanel 在 Chrome DevTools 中提供专注的 API 请求与响应工作台。Browser 模式会在你批准精确目标站点后直接从扩展发起请求。对于 Browser Fetch 无法准确表达的请求，可以显式选择自己部署并信任的 Remote Relay；xPanel 不会自动切换执行器，也不会在未经确认时把数据发送给 Relay。

主要功能：

- 编辑 URL 参数、认证、请求头以及 JSON、文本、URL 编码和 multipart 请求正文。
- 查看美化或原始响应、响应头、耗时、重定向以及返回的 Set-Cookie。
- 导入和导出 cURL（Bash）、PowerShell、Node fetch、HAR 1.2、OpenAPI 3、Swagger 2 和版本化 xPanel 集合。
- 在本地保存集合和收藏，快速美化 JSON、复制结果并中止请求。
- 默认超时 60 秒，显示真实请求阶段；响应大小已知时显示下载百分比。
- 可选连接由用户自行部署并信任的 Relay；xPanel 不提供公共代理，也不运营后端。

xPanel 不包含统计分析、广告、账号系统或遥测。敏感值默认仅保留在会话中，导出默认脱敏，只有用户明确选择时才包含敏感数据。

2.0 版以 Manifest V3 和精确的可选站点授权，替代旧版 Manifest V2 的 localhost CORS 修改功能。

## Privacy practices

### Single purpose

Provide an API request and response workbench inside Chrome DevTools.

### Permission justifications

| Dashboard field                                  | Text to enter                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                                        | Stores user-created request drafts, collections, favorites, preferences, optional response examples, and Relay profile metadata locally. Session-only Relay secrets use `chrome.storage.session`; persistent storage requires a separate user confirmation.                                     |
| `http://*/*`, `https://*/*` optional host access | At send time, xPanel asks only for the exact origin entered by the user so Browser mode can perform that request, resolve an external OpenAPI reference the user approved, or contact a Relay endpoint the user configured. These origins are optional and are not granted globally by default. |

### Remote code

Select **No, I am not using remote code**.

xPanel neither downloads nor evaluates executable code. Remote Relay exchanges
strictly validated request and response data using the versioned Relay V1
protocol. Imported Bash, PowerShell, and JavaScript text is parsed as static
data and is never executed.

### Data categories and use

Disclose the following categories because Chrome Web Store disclosure applies
even when data remains on the device:

| Category                        | Why xPanel handles it                                                                                                                  | Use                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Authentication information      | User-entered Authorization, Cookie, API-key, and Relay-token values may be part of a request.                                          | App functionality only. |
| Web history / browsing activity | Request URLs and DevTools Network HAR entries identify resources the user chooses to inspect or replay.                                | App functionality only. |
| Website content                 | Request and response bodies, headers, OpenAPI documents, and HAR content are displayed, transformed, or saved at the user's direction. | App functionality only. |
| User-generated content          | Request drafts, bodies, collections, names, and imported documents are created or selected by the user.                                | App functionality only. |

Certify that data is not sold, is not used for advertising, creditworthiness,
or unrelated purposes, and is not transferred except as required to perform the
user-selected request. Browser traffic goes to the selected destination. Remote
traffic goes to the user-selected self-hosted Relay and then the destination,
only after an in-product disclosure and confirmation. No request data is sent
to the xPanel developer.

## Reviewer instructions

1. Install version 2.0.0 and open any ordinary web page.
2. Open Chrome DevTools and select the **xPanel** tab. The extension popup is
   informational; the full product is the DevTools panel.
3. In the default **Browser** executor, enter a public test API URL and click
   **Send**. Approve the exact origin when Chrome asks. No account or test
   credential is required.
4. Verify the response Pretty/Raw/Headers/Timing tabs, copy actions, 60-second
   default timeout under Options, progress bar, and Stop button.
5. Open Import and use a static cURL request, or choose Current Network HAR.
   Imported scripts are parsed and never executed.
6. Open the executor's Relay manager to inspect optional Remote Relay profiles.
   xPanel does not operate or bundle a Relay endpoint. Users must explicitly
   configure a service they deploy and trust, select it, and confirm the data
   disclosure before the first Remote send in each Chrome session. Browser
   remains the default after restart.

## Graphic assets

- English screenshots: [`assets/en`](assets/en)
- Chinese screenshots: [`assets/zh_CN`](assets/zh_CN)
- Store icon and small promo tile: [`assets/global`](assets/global)

Upload screenshots in numeric filename order. Every screenshot is an actual
1280x800 capture from the unpacked MV3 DevTools panel in an undocked DevTools
window. The promo tile is 440x280, and the store icon is 128x128.

## Final dashboard checklist

- Upload the reviewed `xpanelextension-2.0.0-chrome.zip` to the existing item.
- Paste the localized listing copy and replace all outdated Manifest V2 images.
- Upload the 128x128 icon, three screenshots per locale, and 440x280 promo tile.
- Complete every Privacy practices field using the text above.
- Confirm distribution settings and that no outdated localhost CORS claim
  remains visible.
- Save the draft and review the public preview.
- Submit for review manually. Do not select any expedited DNR-only review path.
