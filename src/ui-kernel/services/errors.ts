/**
 * 错误预算（FRONTEND-PLUGINIZATION §2.7）：按插件计数渲染错误与插件自报的错误。
 *
 * 社区插件累计错误达到预算即自动卸载并登记为停用（插件管理页可见）；官方插件只计数、上报，不自动卸载。
 * 重新安装同一插件时计数清零、停用记录移除。
 */
import type { UiPluginOrigin } from '../slots';
import { reportFrontendError } from '@/logging/errorReporter';

export type UiErrorPhase = 'render' | 'filter' | 'report';

export interface UiPluginErrorReport {
  pluginId: string;
  origin: UiPluginOrigin;
  phase: UiErrorPhase;
  slot?: string;
  entryId?: string;
  message: string;
  error: unknown;
  at: number;
}

export interface UiDisabledPlugin {
  pluginId: string;
  reason: 'error-budget';
  errors: number;
  at: number;
}

export interface UiErrorBudgetOptions {
  /** 社区插件可累计的错误次数，达到即卸载；缺省 3。 */
  community?: number;
  /** 官方插件的预算；缺省不限（只上报）。 */
  builtin?: number;
  /** 每个插件保留的最近错误条数；缺省 20。 */
  keep?: number;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class UiErrorBudget {
  private readonly _reports = new Map<string, UiPluginErrorReport[]>();
  private readonly _counts = new Map<string, number>();
  private readonly _disabled = new Map<string, UiDisabledPlugin>();
  private readonly _listeners = new Set<() => void>();
  private _version = 0;

  constructor(
    private readonly _options: UiErrorBudgetOptions,
    private readonly _onExhausted: (pluginId: string) => void,
    private readonly _now: () => number = Date.now,
  ) {}

  budget(origin: UiPluginOrigin): number {
    return origin === 'builtin' ? this._options.builtin ?? Infinity : this._options.community ?? 3;
  }

  report(input: Omit<UiPluginErrorReport, 'message' | 'at'>): UiPluginErrorReport {
    const report: UiPluginErrorReport = { ...input, message: messageOf(input.error), at: this._now() };
    console.error(`[ui-plugins] ${input.pluginId} failed (${input.phase}${input.slot ? ` in ${input.slot}` : ''}):`, input.error);
    void reportFrontendError(input.error, { kind: 'CAUGHT_ERROR', component: input.pluginId,
      extra: { pluginId: input.pluginId, operation: 'plugin.' + input.phase, slot: input.slot } }).catch(() => {});
    const list = this._reports.get(input.pluginId) ?? [];
    list.push(report);
    list.splice(0, Math.max(0, list.length - (this._options.keep ?? 20)));
    this._reports.set(input.pluginId, list);
    const count = (this._counts.get(input.pluginId) ?? 0) + 1;
    this._counts.set(input.pluginId, count);
    const exhausted = count >= this.budget(input.origin) && !this._disabled.has(input.pluginId);
    if (exhausted) this._disabled.set(input.pluginId, { pluginId: input.pluginId, reason: 'error-budget', errors: count, at: report.at });
    this._bump();
    if (exhausted) this._onExhausted(input.pluginId);
    return report;
  }

  count(pluginId: string): number {
    return this._counts.get(pluginId) ?? 0;
  }

  list(pluginId?: string): readonly UiPluginErrorReport[] {
    if (pluginId !== undefined) return [...(this._reports.get(pluginId) ?? [])];
    return [...this._reports.values()].flat().sort((a, b) => a.at - b.at);
  }

  disabled(): readonly UiDisabledPlugin[] {
    return [...this._disabled.values()].sort((a, b) => a.pluginId.localeCompare(b.pluginId));
  }

  /** 插件（重新）安装时调用：清零计数、移除停用记录；保留历史错误供排查。 */
  reset(pluginId: string): void {
    const changed = this._counts.delete(pluginId) || this._disabled.delete(pluginId);
    this._disabled.delete(pluginId);
    if (changed) this._bump();
  }

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => void this._listeners.delete(listener);
  };

  version = (): number => this._version;

  private _bump(): void {
    this._version++;
    for (const fn of [...this._listeners]) fn();
  }
}
