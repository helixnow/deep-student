/**
 * 插件装载 / 安装失败的结构化错误（`decisions/2026-11-07-plugin-ecosystem-v1.md` P0）。
 * 只依赖无导入的 `platform/errors/unsupported-on-platform.ts`：前端 UI 内核可直接导入 {@link parseDegradedReason}
 * 解析 `plugin:host|status` / UI 清单 v2 的降级原因。
 */
import { UNSUPPORTED_ON_PLATFORM } from '../platform/errors/unsupported-on-platform.ts';

/**
 * 插件装载 / 安装失败的结构化错误码。降级原因（`DegradedPlugin.reason`）以 `<CODE>: ` 开头，
 * 用 {@link parseDegradedReason} 取回；缺服务和 apply 异常同样有稳定前缀，原始文字保留为 detail。
 */
export const PLUGIN_LOAD_CODES = [
  /** 社区插件模块旁找不到含 `deepStudent` 的 package.json。 */
  'MANIFEST_MISSING',
  /** manifestVersion 高于本应用支持的版本：提示升级应用。 */
  'MANIFEST_VERSION_UNSUPPORTED',
  /** engines.deepStudent 不包含当前应用版本。 */
  'ENGINE_INCOMPATIBLE',
  /** 不满足契约 schema（含 engines 缺失或不在范围子集内、requires 依赖自己或区间为空）。 */
  'MANIFEST_INVALID',
  /** assigned publisher 用在了不允许的来源（如社区插件用 `dstu.`）。 */
  'ID_RESERVED',
  /** profile 条目 id、manifest id 与模块 `meta.id` 不一致。 */
  'ID_MISMATCH',
  /** 模块 `meta.version` 与 package.json#version 不一致。 */
  'VERSION_MISMATCH',
  /** manifest 没有 Host 半入口，或入口不是 profile 指向的模块。 */
  'HOST_ENTRY_MISMATCH',
  /** 社区 Host 模块缺失、导入失败或未导出有效插件。 */
  'IMPORT_FAILED',
  /** 当前平台不在插件声明的平台内（`platform/errors` 的统一代号，与存储层、`ctx.http` 同名同语义）。 */
  UNSUPPORTED_ON_PLATFORM,
  /** requires 中的插件不在本次装载中。 */
  'REQUIRES_MISSING',
  /** requires 中的插件版本不在范围内。 */
  'REQUIRES_INCOMPATIBLE',
  /** permissions 含未知 kind（v1 只有 `service`）。 */
  'PERMISSION_UNKNOWN_KIND',
  /** inject 了未在 permissions 中声明、也不是隐式授予的服务。 */
  'PERMISSION_UNDECLARED',
  /** 社区插件提供的服务名不在由 id 派生的服务名空间内。 */
  'SERVICE_NAME_INVALID',
  /** 社区插件提供的服务名与本次装载中其他插件冲突。 */
  'SERVICE_CONFLICT',
  /** 社区插件声明 `meta.commands`、注入或调用 v1 不开放的 kernel 服务（`commands`/`protocols`/`backendEvents`/`shell`）。 */
  'KERNEL_API_FORBIDDEN',
  /** profile 配置不满足插件的 `Config` schema。 */
  'CONFIG_INVALID',
  /** 插件的 `Config` schema 声明了凭据字段（凭据走密钥服务，不进配置）。 */
  'CONFIG_CREDENTIAL',
  /** 社区插件需要用户同意（K3）：缺记录、版本变化或权限摘要变化；不构成装载许可。 */
  'CONSENT_REQUIRED',
  /** 安全模式（W06 `--safe-mode`）只允许官方插件：社区插件的安装 / 启用 / profile 变更被拒绝。 */
  'SAFE_MODE_ACTIVE',
  /** 注入依赖缺失（含依赖未启动插件的级联）。 */
  'SERVICE_MISSING',
  /** apply 或启动校验失败；原异常文本保留在 detail。 */
  'APPLY_FAILED',
] as const;

export type PluginLoadCode = (typeof PLUGIN_LOAD_CODES)[number];

const CODES: ReadonlySet<string> = new Set(PLUGIN_LOAD_CODES);

/** 装载 / 安装插件失败。`message` 形如 `<CODE>: <说明>`，直接作为降级原因。 */
export class PluginLoadError extends Error {
  override name = 'PluginLoadError';
  readonly code: PluginLoadCode;
  readonly pluginId: string;
  readonly detail: string;

  constructor(code: PluginLoadCode, pluginId: string, detail: string, options?: ErrorOptions) {
    super(`${code}: ${detail}`, options);
    this.code = code;
    this.pluginId = pluginId;
    this.detail = detail;
  }
}

/** 拆出降级原因中的错误码；未知或外部自定义的无前缀文本仍返回原 detail。 */
export function parseDegradedReason(reason: string): { code?: PluginLoadCode; detail: string } {
  const match = /^([A-Z][A-Z_]+): ([\s\S]*)$/.exec(reason);
  if (match && CODES.has(match[1]!)) return { code: match[1] as PluginLoadCode, detail: match[2]! };
  return { detail: reason };
}
