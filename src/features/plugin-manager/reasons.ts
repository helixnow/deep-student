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

export type ManagerErrorCategory =
  | 'path'
  | 'archive'
  | 'manifest'
  | 'compatibility'
  | 'permission'
  | 'network'
  | 'runtime'
  | 'general';

export interface FriendlyManagerError {
  readonly explanation: string;
  readonly technical: string;
  readonly category: ManagerErrorCategory;
}

const MANAGER_ERROR_KEYS: Readonly<Record<string, string>> = {
  MANIFEST_INVALID: 'error.reasons.manifestInvalid',
  MANIFEST_MISSING: 'error.reasons.manifestMissing',
  MANIFEST_VERSION_UNSUPPORTED: 'error.reasons.manifestVersionUnsupported',
  ENGINE_INCOMPATIBLE: 'error.reasons.engineIncompatible',
  ID_RESERVED: 'error.reasons.idReserved',
  ID_MISMATCH: 'error.reasons.idMismatch',
  VERSION_MISMATCH: 'error.reasons.versionMismatch',
  HOST_ENTRY_MISMATCH: 'error.reasons.hostEntryMismatch',
  PERMISSION_UNKNOWN_KIND: 'error.reasons.permissionUnknown',
  PERMISSION_UNDECLARED: 'error.reasons.permissionUndeclared',
  PLUGIN_INSTALL_UNAVAILABLE: 'error.reasons.installUnavailable',
  SAFE_MODE_ACTIVE: 'error.reasons.safeMode',
  CONSENT_REQUIRED: 'error.reasons.consentRequired',
  CONSENT_STALE: 'error.reasons.consentStale',
  PLUGIN_UNLOAD_BLOCKED: 'error.reasons.unloadBlocked',
  PLUGIN_NOT_FOUND: 'error.reasons.pluginNotFound',
  PROFILE_READ_FAILED: 'error.reasons.profileReadFailed',
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

const MANAGER_ERROR_CATEGORIES: Readonly<Record<string, ManagerErrorCategory>> = {
  MANIFEST_INVALID: 'manifest',
  MANIFEST_MISSING: 'manifest',
  ID_RESERVED: 'manifest',
  ID_MISMATCH: 'manifest',
  VERSION_MISMATCH: 'manifest',
  HOST_ENTRY_MISMATCH: 'manifest',
  MANIFEST_VERSION_UNSUPPORTED: 'compatibility',
  ENGINE_INCOMPATIBLE: 'compatibility',
  UNSUPPORTED_ON_PLATFORM: 'compatibility',
  PERMISSION_UNKNOWN_KIND: 'permission',
  PERMISSION_UNDECLARED: 'permission',
  CONSENT_REQUIRED: 'permission',
  CONSENT_STALE: 'permission',
  REMOTE_PACK_INVALID_URL: 'network',
  REMOTE_PACK_HTTPS_REQUIRED: 'network',
  REMOTE_PACK_HOST_BLOCKED: 'network',
  REMOTE_PACK_REDIRECT_BLOCKED: 'network',
  REMOTE_PACK_BAD_EXTENSION: 'archive',
  REMOTE_PACK_TOO_LARGE: 'archive',
  REMOTE_PACK_CREDENTIALS_FORBIDDEN: 'network',
  REMOTE_PACK_HTTP_ERROR: 'network',
  STAGE_UPLOAD_FAILED: 'network',
  SAFE_MODE_ACTIVE: 'runtime',
  PLUGIN_UNLOAD_BLOCKED: 'runtime',
  PLUGIN_NOT_FOUND: 'runtime',
  PROFILE_READ_FAILED: 'runtime',
  PLUGIN_ENABLE_FAILED: 'runtime',
  PLUGIN_INSTALL_UNAVAILABLE: 'runtime',
};

function stripLeadingCode(detail: string, ...codes: string[]): string {
  let text = detail.trim();
  for (const code of codes) {
    if (!code) continue;
    const prefix = new RegExp(`^${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*`, 'i');
    text = text.replace(prefix, '').trim();
  }
  return text;
}

export function resolveManagerErrorCode(code: string, detail?: string): string {
  if ((code === 'PLUGIN_INSTALL_FAILED' || code === 'OPERATION_FAILED') && detail) {
    const prefixed = /^([A-Z][A-Z0-9_]+):/.exec(detail.trim())?.[1];
    if (prefixed && prefixed !== 'PLUGIN_INSTALL_FAILED' && prefixed !== 'OPERATION_FAILED') return prefixed;
    if (/invalid path|escapes|traversal|\.\.|zip slip|symlink|non-regular zip|foreign root|duplicate zip path/i.test(detail)) {
      return 'PLUGIN_PACKAGE_INVALID';
    }
    if (/manifestVersion\s+\d+|newer than this app supports/i.test(detail)) {
      return 'MANIFEST_VERSION_UNSUPPORTED';
    }
    if (/requires app version|requires plugin API|engine_incompatible/i.test(detail)) {
      return 'ENGINE_INCOMPATIBLE';
    }
    if (/no "deepStudent" manifest/i.test(detail)) {
      return 'MANIFEST_MISSING';
    }
    if (/json|package\.json|zip|central directory|archive|corrupt|checksum|sha256|missing (host|ui) entrypoint|missing declarative\.|expected \.dstuplugin|0 bytes|empty/i.test(detail)) {
      return 'PLUGIN_PACKAGE_INVALID';
    }
    if (/manifest|engines\.deepStudent|\/deepStudent|schema/i.test(detail)) {
      return 'MANIFEST_INVALID';
    }
  }
  return code;
}

/** Maps raw Host / ZIP / SSRF error codes into learner-friendly copy while keeping technical context available. */
export function describeManagerError(
  t: (key: string, options?: Record<string, unknown>) => string,
  code: string,
  detail?: string,
): FriendlyManagerError {
  const effectiveCode = resolveManagerErrorCode(code, detail);
  const cleanedDetail = detail?.replace(/^(?:PLUGIN_INSTALL_FAILED|OPERATION_FAILED):\s*/i, '').trim();
  const technical = cleanedDetail
    ? (cleanedDetail.startsWith(`${effectiveCode}:`) ? cleanedDetail : `${effectiveCode}: ${cleanedDetail}`)
    : effectiveCode;

  if (effectiveCode === 'PLUGIN_PACKAGE_INVALID' || effectiveCode === 'PLUGIN_WORKSHOP_PATH_INVALID') {
    const raw = stripLeadingCode(cleanedDetail ?? '', effectiveCode, 'PLUGIN_PACKAGE_INVALID', 'PLUGIN_WORKSHOP_PATH_INVALID');
    if (/invalid path|escapes|traversal|\.\.|zip slip|symlink|non-regular zip|foreign root|duplicate zip path/i.test(raw)) {
      return {
        category: 'path',
        explanation: raw ? t('error.reasons.packageTraversalWithDetail', { detail: raw }) : t('error.reasons.packageTraversal'),
        technical,
      };
    }
    if (/package\.json.*missing|missing.*package\.json|missing package manifest/i.test(raw)) {
      return { category: 'manifest', explanation: t('error.reasons.packageMissingManifest'), technical };
    }
    if (/missing (?:host|ui) entrypoint|missing declarative\.|invalid (?:host|ui) entrypoint|invalid declarative\./i.test(raw)) {
      return { category: 'manifest', explanation: t('error.reasons.packageMissingEntry', { detail: raw }), technical };
    }
    if (/not valid json|invalid json|syntaxerror|unexpected token|json/i.test(raw)) {
      return { category: 'manifest', explanation: t('error.reasons.packageInvalidJson'), technical };
    }
    if (/sha256|checksum|tamper/i.test(raw)) {
      return { category: 'archive', explanation: t('error.reasons.packageChecksumMismatch', { detail: raw }), technical };
    }
    if (/exceeds.*mib|too many|too large/i.test(raw)) {
      return { category: 'archive', explanation: t('error.reasons.packageTooLarge'), technical };
    }
    if (/expected \.dstuplugin|expected \.dspack|unsupported.*extension/i.test(raw)) {
      return { category: 'archive', explanation: t('error.reasons.packageBadExtension'), technical };
    }
    if (/0 bytes|empty/i.test(raw)) {
      return { category: 'archive', explanation: t('error.reasons.packageEmpty'), technical };
    }
    if (/zip|central directory|archive|corrupt|eof|signature|deflate/i.test(raw)) {
      return { category: 'archive', explanation: t('error.reasons.packageInvalidZip'), technical };
    }
    return {
      category: 'archive',
      explanation: raw ? t('error.reasons.packageInvalidWithDetail', { detail: raw }) : t('error.reasons.packageInvalid'),
      technical,
    };
  }

  if (effectiveCode === 'MANIFEST_INVALID' && cleanedDetail) {
    const cleanManifestDetail = stripLeadingCode(cleanedDetail, 'MANIFEST_INVALID');
    return {
      category: 'manifest',
      explanation: cleanManifestDetail
        ? t('error.reasons.manifestInvalidWithDetail', { detail: cleanManifestDetail })
        : t('error.reasons.manifestInvalid'),
      technical,
    };
  }

  if (effectiveCode === 'ENGINE_INCOMPATIBLE' && cleanedDetail) {
    const cleanDetail = stripLeadingCode(cleanedDetail, 'ENGINE_INCOMPATIBLE');
    return {
      category: 'compatibility',
      explanation: cleanDetail
        ? t('error.reasons.engineIncompatibleWithDetail', { detail: cleanDetail })
        : t('error.reasons.engineIncompatible'),
      technical,
    };
  }

  if (effectiveCode === 'MANIFEST_VERSION_UNSUPPORTED' && cleanedDetail) {
    const cleanDetail = stripLeadingCode(cleanedDetail, 'MANIFEST_VERSION_UNSUPPORTED');
    return {
      category: 'compatibility',
      explanation: cleanDetail
        ? t('error.reasons.manifestVersionUnsupportedWithDetail', { detail: cleanDetail })
        : t('error.reasons.manifestVersionUnsupported'),
      technical,
    };
  }

  const key = MANAGER_ERROR_KEYS[effectiveCode] ?? 'error.reasons.generic';
  const category = MANAGER_ERROR_CATEGORIES[effectiveCode] ?? 'general';
  return {
    category,
    explanation: t(key),
    technical: effectiveCode === 'PLUGIN_INSTALL_FAILED' ? cleanedDetail || t('error.reasons.installFailed') : technical,
  };
}

/**
 * Determines whether a degraded reason represents a real plugin fault/failure,
 * as opposed to normal Safe Mode pausing (`SAFE_MODE_ACTIVE`) or pending consent (`CONSENT_REQUIRED`).
 * Evaluates both UI-side and Host-side reasons so a non-fault UI status (e.g. `SAFE_MODE_ACTIVE`)
 * never masks a real Host load/manifest fault.
 */
export function isFaultDegradedReason(reason?: string, uiDegraded?: { readonly code?: string; readonly consentRequired?: boolean }): boolean {
  if (uiDegraded) {
    const uiNonFault = uiDegraded.consentRequired === true
      || uiDegraded.code === 'SAFE_MODE_ACTIVE'
      || uiDegraded.code === 'CONSENT_REQUIRED';
    if (!uiNonFault) return true;
  }
  if (!reason || !reason.trim()) return false;
  const parsed = parsePluginReason(reason.trimStart());
  if (parsed.code === 'SAFE_MODE_ACTIVE' || parsed.code === 'CONSENT_REQUIRED') return false;
  return true;
}

/**
 * Formats a concise, localized fault/isolation explanation for a degraded or crashed plugin.
 * Returns `null` if the plugin has no active fault.
 */
export function describePluginFault(
  t: (key: string, options?: Record<string, unknown>) => string,
  options: {
    readonly degradedReason?: string;
    readonly uiDegraded?: { readonly code?: PluginUiDegradedCode; readonly detail: string; readonly consentRequired: boolean };
    readonly runtime?: string;
    readonly runtimeDetail?: string;
    readonly autoUninstalled?: PluginAutoUninstallReason | null;
  },
): { readonly label: string; readonly detail?: string; readonly code?: PluginUiDegradedCode } | null {
  if (options.autoUninstalled) {
    return {
      label: t('errorBudget.row', {
        errors: options.autoUninstalled.errors,
        budget: options.autoUninstalled.budget,
      }),
    };
  }
  if (options.uiDegraded && isFaultDegradedReason(undefined, options.uiDegraded)) {
    const label = degradeCodeLabel(t, options.uiDegraded.code) ?? t('degraded.title');
    const detail = options.uiDegraded.detail.trim() || undefined;
    return {
      code: options.uiDegraded.code,
      label,
      detail,
    };
  }
  if (options.degradedReason && isFaultDegradedReason(options.degradedReason)) {
    const parsed = parsePluginReason(options.degradedReason.trimStart());
    const label = degradeCodeLabel(t, parsed.code) ?? t('degraded.title');
    const detail = parsed.detail.trim() || undefined;
    return {
      code: parsed.code,
      label,
      detail,
    };
  }
  if (options.runtime === 'error') {
    return {
      label: t('runtime.error'),
      detail: options.runtimeDetail?.trim() || undefined,
    };
  }
  return null;
}
