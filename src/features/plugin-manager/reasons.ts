/**
 * 降级原因与 UI 错误预算（FE-A3 / FRONTEND-PLUGINIZATION §2.7）在管理页的展示逻辑。
 *
 * 降级原因统一用 Host 的 {@link parseDegradedReason} 拆 `<CODE>: <detail>`，不另写正则；
 * 错误预算直接读内核 `UiErrorBudget`（结构类型，避免管理页反向依赖内核实例），
 * 社区插件累计错误达到预算（默认 3 次）会被内核自动卸载并在此列出原因。
 */
import { parseDegradedReason, type PluginLoadCode } from '../../../host/kernel/plugin-load-error.ts';
import { CONSENT_REQUIRED_CODE, type PluginUiDegradedCode } from './ui-status';
import type { PluginOrigin } from './types';

export interface ParsedPluginReason {
  readonly code?: PluginLoadCode;
  readonly detail: string;
}

/** 拆降级原因；没有错误码（缺服务、apply 抛错等既有文字）时只返回原文。 */
export function parsePluginReason(reason: string): ParsedPluginReason {
  return parseDegradedReason(reason);
}

/** 错误码 → `plugin_manager:degraded.code.*` 的 key 后缀；新增错误码时由类型检查提醒补齐。 */
export const DEGRADED_CODE_KEYS: Record<PluginLoadCode, string> = {
  MANIFEST_MISSING: 'manifest_missing',
  MANIFEST_VERSION_UNSUPPORTED: 'manifest_version_unsupported',
  ENGINE_INCOMPATIBLE: 'engine_incompatible',
  MANIFEST_INVALID: 'manifest_invalid',
  ID_RESERVED: 'id_reserved',
  ID_MISMATCH: 'id_mismatch',
  VERSION_MISMATCH: 'version_mismatch',
  HOST_ENTRY_MISMATCH: 'host_entry_mismatch',
  IMPORT_FAILED: 'import_failed',
  UNSUPPORTED_ON_PLATFORM: 'unsupported_on_platform',
  REQUIRES_MISSING: 'requires_missing',
  REQUIRES_INCOMPATIBLE: 'requires_incompatible',
  PERMISSION_UNKNOWN_KIND: 'permission_unknown_kind',
  PERMISSION_UNDECLARED: 'permission_undeclared',
  SERVICE_NAME_INVALID: 'service_name_invalid',
  SERVICE_CONFLICT: 'service_conflict',
  KERNEL_API_FORBIDDEN: 'kernel_api_forbidden',
  CONFIG_INVALID: 'config_invalid',
  CONFIG_CREDENTIAL: 'config_credential',
  CONSENT_REQUIRED: 'consent_required',
  SAFE_MODE_ACTIVE: 'safe_mode_active',
  SERVICE_MISSING: 'service_missing',
  APPLY_FAILED: 'apply_failed',
};

/** `CONSENT_REQUIRED` 不是 Host 的装载错误码（W17 单独暴露），文案 key 单独登记。 */
export const CONSENT_REQUIRED_KEY = 'consent_required';

/** UI 侧降级码（Host 错误码 + 同意）→ 文案 key 后缀。 */
export function degradedCodeKey(code: PluginUiDegradedCode): string {
  return code === CONSENT_REQUIRED_CODE ? CONSENT_REQUIRED_KEY : DEGRADED_CODE_KEYS[code];
}

/** 降级码 → 本地化文案；没有码时返回 undefined（调用方只显示原文）。 */
export function degradeCodeLabel(
  t: (key: string) => string,
  code: PluginUiDegradedCode | undefined,
): string | undefined {
  return code ? t(`degraded.code.${degradedCodeKey(code)}`) : undefined;
}

/**
 * 内核 `UiErrorBudget` 的只读视图（`disabled` / `count` / `budget` / `subscribe` / `version`）。
 * 真实实例可直接传入；测试也可以给一个最小实现。
 */
export interface PluginErrorBudgetView {
  disabled(): readonly { readonly pluginId: string; readonly errors: number }[];
  count(pluginId: string): number;
  budget(origin: PluginOrigin): number;
  subscribe(listener: () => void): () => void;
  version(): number;
}

export interface PluginAutoUninstallReason {
  readonly pluginId: string;
  readonly errors: number;
  readonly budget: number;
}

/** 当前所有“达到错误预算被自动卸载”的插件，附带实际预算值。 */
export function autoUninstalled(budget: PluginErrorBudgetView): PluginAutoUninstallReason[] {
  const threshold = budget.budget('community');
  return budget.disabled().map((entry) => ({
    pluginId: entry.pluginId,
    errors: entry.errors,
    // 官方插件不会自动卸载；这里只可能是社区插件，预算按社区口径显示。
    budget: Number.isFinite(threshold) ? threshold : entry.errors,
  }));
}

/** 单个插件当前累计错误数与预算（用于行内“2/3”提示）。官方插件没有有限预算，返回 null。 */
export function errorBudgetOf(
  budget: PluginErrorBudgetView | null | undefined,
  pluginId: string,
  origin: PluginOrigin,
): { errors: number; budget: number } | null {
  if (!budget) return null;
  const threshold = budget.budget(origin);
  if (!Number.isFinite(threshold) || threshold <= 0) return null;
  return { errors: budget.count(pluginId), budget: threshold };
}

export interface FriendlyManagerError {
  readonly explanation: string;
  readonly technical: string;
}

const MANAGER_ERROR_KEYS: Readonly<Record<string, string>> = {
  MANIFEST_INVALID: 'error.reasons.manifestInvalid',
  MANIFEST_MISSING: 'error.reasons.packageInvalid',
  MANIFEST_VERSION_UNSUPPORTED: 'error.reasons.engineIncompatible',
  ENGINE_INCOMPATIBLE: 'error.reasons.engineIncompatible',
  ID_RESERVED: 'error.reasons.idReserved',
  PERMISSION_UNDECLARED: 'error.reasons.permissionUndeclared',
  SAFE_MODE_ACTIVE: 'error.reasons.safeMode',
  CONSENT_REQUIRED: 'error.reasons.consentRequired',
  CONSENT_STALE: 'error.reasons.consentStale',
  PLUGIN_UNLOAD_BLOCKED: 'error.reasons.unloadBlocked',
  PROFILE_CONFLICT: 'error.reasons.profileConflict',
  REVISION_CONFLICT: 'error.reasons.profileConflict',
  PLUGIN_ENABLE_FAILED: 'error.reasons.enableFailed',
  PLUGIN_INSTALL_FAILED: 'error.reasons.installFailed',
  REMOTE_PACK_INVALID_URL: 'error.reasons.urlInvalid',
  REMOTE_PACK_HTTPS_REQUIRED: 'error.reasons.urlHttpsRequired',
  REMOTE_PACK_HOST_BLOCKED: 'error.reasons.urlHostBlocked',
  REMOTE_PACK_REDIRECT_BLOCKED: 'error.reasons.urlRedirectBlocked',
  REMOTE_PACK_BAD_EXTENSION: 'error.reasons.urlBadExtension',
  REMOTE_PACK_TOO_LARGE: 'error.reasons.urlTooLarge',
  REMOTE_PACK_CREDENTIALS_FORBIDDEN: 'error.reasons.urlCredentials',
  REMOTE_PACK_HTTP_ERROR: 'error.reasons.urlHttpError',
  STAGE_UPLOAD_FAILED: 'error.reasons.stageUploadFailed',
};

/** Maps raw Host / ZIP / SSRF error codes into learner-friendly copy while keeping technical context available. */
export function describeManagerError(
  t: (key: string, options?: Record<string, unknown>) => string,
  code: string,
  detail?: string,
): FriendlyManagerError {
  const technical = detail ? (detail.startsWith(`${code}:`) ? detail : `${code}: ${detail}`) : code;
  if (code === 'PLUGIN_PACKAGE_INVALID') {
    const raw = detail ?? '';
    const key = /invalid path|escapes|traversal|\.\./i.test(raw)
      ? 'error.reasons.packageTraversal'
      : /json|package\.json/i.test(raw)
        ? 'error.reasons.packageInvalidJson'
        : /zip|central directory|archive/i.test(raw)
          ? 'error.reasons.packageInvalidZip'
          : 'error.reasons.packageInvalid';
    return { explanation: t(key), technical };
  }
  if (code === 'MANIFEST_INVALID' && detail && detail.trim() !== '') {
    const cleanDetail = detail.replace(/^MANIFEST_INVALID:\s*/i, '').trim();
    return {
      explanation: t('error.reasons.manifestInvalidWithDetail', { detail: cleanDetail }),
      technical,
    };
  }
  const key = MANAGER_ERROR_KEYS[code] ?? 'error.reasons.generic';
  return { explanation: t(key), technical };
}
