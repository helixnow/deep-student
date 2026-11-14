/**
 * Host 插件状态（FE-A3）：UI 半据此对账——配对的 Host 半未安装/被禁用时撤下 UI 半，降级时换成降级视图。
 *
 * 来源是 Host 的 `plugin:ui|manifest {version: 2}`（已安装插件全集 + 降级项 + 安全模式）与
 * `plugin:host|status`（降级项）；两者都可能晚于首帧到达。到达前每个 Host 插件都是 `unknown`，按“在线”对待
 * （乐观安装），因此首帧不等清单。只拿到降级列表（旧 Host 没有 v2 清单）时只判降级，不判缺失。
 *
 * 降级原因的错误码与 Host 同源（`host/kernel/plugin-load-error.ts` 的 `parseDegradedReason`），
 * `CONSENT_REQUIRED` 表示插件因同意记录不匹配而未加载，界面上给“同意”入口，不当作坏插件。
 */
import { parseDegradedReason, type PluginLoadCode } from '../../../host/kernel/plugin-load-error.ts';

/** W32 K3：同意记录缺失/版本或权限摘要不匹配，插件在导入前被拦下。 */
export const CONSENT_REQUIRED = 'CONSENT_REQUIRED';

/** UI 认识的降级错误码与 Host 的装载/安装错误码一致。 */
export type UiDegradedCode = PluginLoadCode;

/** 结构化的降级原因。 */
export interface UiDegradedInfo {
  /** 可识别的错误码；旧文本（缺服务、apply 失败）没有。 */
  code?: UiDegradedCode;
  /** 去掉 `<CODE>: ` 前缀后的说明。 */
  detail: string;
  /** 需要用户同意后才能加载（W32/W01 的可信命令负责确认与落账）。 */
  consentRequired: boolean;
}

/**
 * 解析 `plugin:host|status` / v2 清单的降级原因，复用 Host 的正式前缀格式并保留 detail。
 */
export function parseHostDegradedReason(reason: string): UiDegradedInfo {
  const text = typeof reason === 'string' ? reason : String(reason ?? '');
  const parsed = parseDegradedReason(text);
  if (parsed.code) return { code: parsed.code, detail: parsed.detail, consentRequired: parsed.code === CONSENT_REQUIRED };
  return { detail: text, consentRequired: false };
}

/** 单个 Host 插件的状态。`unknown`：清单未到，按在线处理。 */
export type HostPluginState = 'unknown' | 'online' | 'degraded' | 'missing';

/** 一个 UI 半（按它需要的全部 Host 插件）的可用性。 */
export type HostAvailability = 'available' | 'degraded' | 'missing';

/** Host 报告的降级项（`DegradedPlugin`，`host/kernel/core.ts`）。 */
export interface HostDegradedPlugin {
  id: string;
  reason: string;
}

/** `UiManifestV2` 中内核关心的部分（`host/kernel/core.ts`）。 */
export interface HostPluginInventory {
  plugins: readonly { id: string }[];
  degraded: readonly HostDegradedPlugin[];
  /** W06/W01：本次会话是安全模式（只装载官方插件）。缺省 = false。 */
  safeMode?: boolean;
}

/** `ctx.ui.hostStatus`：只读查询与订阅（订阅随插件卸载撤销）。 */
export interface UiHostStatusHandle {
  /** 是否已拿到 Host 的已安装插件全集（v2 清单）。 */
  readonly known: boolean;
  /** 安全模式会话（v2 清单的 `safeMode`）；此时渲染端不加载社区 UI。 */
  readonly safeMode: boolean;
  state(hostId: string): HostPluginState;
  /** 降级原因（非降级为 undefined）。 */
  reason(hostId: string): string | undefined;
  /** 结构化降级原因（非降级为 undefined）。 */
  degraded(hostId: string): UiDegradedInfo | undefined;
  /** W32 K3：该插件需要用户同意才能加载。 */
  consentRequired(hostId: string): boolean;
  availability(hostIds: readonly string[]): HostAvailability;
  subscribe(listener: () => void): () => void;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

function sameMap(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  return a.size === b.size && [...a].every(([id, reason]) => b.get(id) === reason);
}

function degradedMap(list: readonly HostDegradedPlugin[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of list) {
    if (item && typeof item.id === 'string' && item.id) map.set(item.id, typeof item.reason === 'string' ? item.reason : '');
  }
  return map;
}

export class UiHostStatusService {
  private _installed: ReadonlySet<string> | undefined;
  private _degraded: ReadonlyMap<string, string> = new Map();
  private _safeMode = false;
  private readonly _listeners = new Set<() => void>();

  get known(): boolean {
    return this._installed !== undefined;
  }

  // RUST-FIX(RF-W17-safe-mode-community-ui): 安全模式标记随 v2 清单进入，供社区 UI 加载前判断
  /** 安全模式会话；由 v2 清单的 `safeMode` 写入。 */
  get safeMode(): boolean {
    return this._safeMode;
  }

  state(hostId: string): HostPluginState {
    if (this._degraded.has(hostId)) return 'degraded';
    if (!this._installed) return 'unknown';
    return this._installed.has(hostId) ? 'online' : 'missing';
  }

  reason(hostId: string): string | undefined {
    return this._degraded.get(hostId);
  }

  /** 结构化降级原因；`state()` 非 `degraded` 时为 undefined。 */
  degraded(hostId: string): UiDegradedInfo | undefined {
    const reason = this._degraded.get(hostId);
    return reason === undefined ? undefined : parseHostDegradedReason(reason);
  }

  /** W32 K3：该插件在等待同意（`CONSENT_REQUIRED`），界面应给确认入口。 */
  consentRequired(hostId: string): boolean {
    return this.degraded(hostId)?.consentRequired === true;
  }

  /** 任一缺失即 missing；否则任一降级即 degraded；否则 available（含 unknown）。 */
  availability(hostIds: readonly string[]): HostAvailability {
    const states = hostIds.map((id) => this.state(id));
    if (states.includes('missing')) return 'missing';
    if (states.includes('degraded')) return 'degraded';
    return 'available';
  }

  /** v2 清单：已安装插件全集、降级项与安全模式一起替换。 */
  update(inventory: HostPluginInventory): void {
    const installed = new Set(inventory.plugins.map((p) => p.id));
    const degraded = degradedMap(inventory.degraded);
    const safeMode = inventory.safeMode === true;
    const changed = this._safeMode !== safeMode
      || !this._installed || !sameSet(this._installed, installed) || !sameMap(this._degraded, degraded);
    this._installed = installed;
    this._degraded = degraded;
    this._safeMode = safeMode;
    if (changed) this._emit();
  }

  /** `plugin:host|status` / `host://plugins-degraded`：只替换降级项。 */
  updateDegraded(list: readonly HostDegradedPlugin[]): void {
    const degraded = degradedMap(list);
    if (sameMap(this._degraded, degraded)) return;
    this._degraded = degraded;
    this._emit();
  }

  subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  private _emit(): void {
    for (const listener of [...this._listeners]) {
      try {
        listener();
      } catch (error) {
        console.error('[ui-plugins] host status listener failed', error);
      }
    }
  }
}
