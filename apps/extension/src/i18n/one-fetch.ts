export const oneFetchEN = {
  oneFetchControlUrl: "Control URL",
  oneFetchGatewayUrl: "Gateway URL",
  oneFetchLoopbackConsent:
    "Allow HTTP only for this computer's loopback service. HTTP does not encrypt tokens or requests.",
  oneFetchLegacyDisabled:
    "Legacy Relay profiles are disabled. Configure a new one-fetch service; credentials are not migrated.",
  oneFetchDeleteLegacyConfirm:
    "Delete this legacy Relay profile and its saved token? This cannot be undone.",
  oneFetchConfigVersion: "Configuration",
  oneFetchCapabilityNotice:
    "Providers may add, replace or merge headers. Unsupported options are blocked; capabilities below describe the service, not a guarantee of browser-equivalent behavior.",
  oneFetchPolicyMode: "System policy mode",
  oneFetchAudit: "Audit",
  oneFetchEmptyAllowlist:
    "An empty administrator allowlist denies all targets. User deny rules cannot grant access.",
  oneFetchTimingUnavailable:
    "DNS/TCP/TLS timing may be unavailable on hosted platforms; missing phases are not zero-duration measurements.",
  oneFetchUserDenyRules: "User deny rules (JSON)",
  oneFetchUserRulesHint:
    "These rules only restrict this profile further. They do not edit the administrator's system policy and are not exported with collections.",
  oneFetchRuleExample: "Insert disabled example",
  oneFetchTarget: "Verified target response",
  oneFetchRelayError: "one-fetch error",
  oneFetchIntermediary: "Unverified intermediary response",
  oneFetchIntegrity: "Body integrity",
  oneFetchVerified: "Verified",
  oneFetchUnverified: "Not verified",
  oneFetchFailed: "Failed",
  oneFetchOuterHeaders: "Outer service headers",
  oneFetchGatewayTiming: "Gateway timing",
  oneFetchClientTiming: "Extension-side timing",
  oneFetchTargetTiming: "Target Server-Timing",
  oneFetchUnavailable: "Unavailable",
  oneFetchLastSuccess: "Show last successful response",
  oneFetchDiagnostic: "Show latest diagnostic response",
  oneFetchExplicitCookies:
    "Remote sends only explicit Cookie headers. Browser cookies are never read or forwarded; Set-Cookie is displayed only.",
  oneFetchConnectionReady:
    "Control is reachable; execution Token and Gateway have not yet been verified. Sending validates them without automatic retries.",
};

export const oneFetchZH: Record<keyof typeof oneFetchEN, string> = {
  oneFetchControlUrl: "Control 服务地址",
  oneFetchGatewayUrl: "Gateway 服务地址",
  oneFetchLoopbackConsent:
    "允许本机回环服务使用 HTTP。我了解 HTTP 不加密 Token 和请求数据。",
  oneFetchLegacyDisabled:
    "旧 Relay 配置已停用。请重新配置 one-fetch 服务，旧凭据不会迁移。",
  oneFetchDeleteLegacyConfirm:
    "删除这个旧 Relay 配置及保存的 Token？此操作无法撤销。",
  oneFetchConfigVersion: "配置版本",
  oneFetchCapabilityNotice:
    "供应商可能增加、修改或合并 Header。不支持的选项会被阻止；下方是服务能力，不代表与浏览器行为完全一致。",
  oneFetchPolicyMode: "系统策略模式",
  oneFetchAudit: "审计状态",
  oneFetchEmptyAllowlist:
    "管理员的白名单为空时，所有目标都会被拒绝。用户黑名单不能授予访问权限。",
  oneFetchTimingUnavailable:
    "云平台可能无法提供 DNS/TCP/TLS 耗时；缺失阶段不表示耗时为零。",
  oneFetchUserDenyRules: "用户黑名单（JSON）",
  oneFetchUserRulesHint:
    "仅进一步限制当前 Profile，不修改管理员系统策略，也不会随集合导出。",
  oneFetchRuleExample: "插入未启用示例",
  oneFetchTarget: "已验证的目标响应",
  oneFetchRelayError: "one-fetch 服务错误",
  oneFetchIntermediary: "来源未验证的中间层响应",
  oneFetchIntegrity: "正文完整性",
  oneFetchVerified: "已核验",
  oneFetchUnverified: "未核验",
  oneFetchFailed: "失败",
  oneFetchOuterHeaders: "外层服务响应头",
  oneFetchGatewayTiming: "Gateway 阶段耗时",
  oneFetchClientTiming: "插件端耗时",
  oneFetchTargetTiming: "目标 Server-Timing",
  oneFetchUnavailable: "不可用",
  oneFetchLastSuccess: "查看上一条成功响应",
  oneFetchDiagnostic: "查看本次诊断响应",
  oneFetchExplicitCookies:
    "Remote 仅发送显式 Cookie，不读取或转发浏览器 Cookie；Set-Cookie 仅展示，不写入浏览器。",
  oneFetchConnectionReady:
    "Control 可连接；execution Token 和 Gateway 尚未验证，将在显式发送时验证，不会自动重试请求。",
};
