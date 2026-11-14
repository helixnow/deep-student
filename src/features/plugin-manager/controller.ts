/**
 * 插件管理页的状态容器：把 {@link PluginManagerAdapter}（Host 命令，W01 接线）与 React 视图隔开。
 *
 * - 所有动作都是“请求 → 等 Host 结果 → 重新拉清单”，不做乐观更新（同意、启停、卸载、保存配置都一样）。
 * - `enabled` 与 `runtime` 永远分开存：已启用不代表正在运行，UI 必须各显示各的。
 * - `CONSENT_REQUIRED` 不是普通错误：结果里带着必须原样展示的 ID/版本/权限，确认后写账本并重载。
 * - 配置保存带 revision；冲突时保留表单内容并标记冲突，不静默覆盖。
 */
import { useSyncExternalStore } from 'react';

import { succeeded } from './result';

import type {
  ManagedPlugin,
  PluginConfigSaveResult,
  PluginConfigRevision,
  PluginConfigState,
  PluginConfigFieldIssue,
  PluginConsentSubject,
  PluginManagerAdapter,
  PluginOperationResult,
  PluginPackageResult,
  PluginPlatform,
} from './types';

export type PluginManagerNotice =
  | { readonly kind: 'enabled-changed'; readonly pluginId: string; readonly enabled: boolean }
  | { readonly kind: 'package'; readonly result: PluginPackageResult }
  | { readonly kind: 'config-saved'; readonly pluginId: string; readonly revision: PluginConfigRevision }
  | { readonly kind: 'consent-granted'; readonly pluginId: string };

export type PluginManagerConfigView =
  | { readonly pluginId: string; readonly status: 'loading' }
  | { readonly pluginId: string; readonly status: 'error'; readonly message: string }
  | {
      readonly pluginId: string;
      readonly status: 'ready';
      readonly config: PluginConfigState;
      readonly saving: boolean;
      /** 另一窗口已保存过（revision 不匹配）；需重新加载后再改。 */
      readonly conflict: boolean;
      readonly message?: string;
      readonly issues?: readonly PluginConfigFieldIssue[];
    };

export interface PluginManagerError {
  readonly code: string;
  readonly detail?: string;
}

export interface PluginManagerState {
  readonly safeMode: boolean;
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly platform: PluginPlatform | null;
  readonly plugins: readonly ManagedPlugin[];
  readonly error: PluginManagerError | null;
  /** 正在进行的动作键：插件 id、`consent`、`package` 等。 */
  readonly busy: readonly string[];
  /** 待用户确认的同意请求；非空时必须展示弹窗，不能后台自动确认。 */
  readonly consent: PluginConsentSubject | null;
  readonly consentBusy: boolean;
  readonly config: PluginManagerConfigView | null;
  readonly notice: PluginManagerNotice | null;
}

const INITIAL_STATE: PluginManagerState = Object.freeze({
  safeMode: false,
  status: 'idle',
  platform: null,
  plugins: [],
  error: null,
  busy: [],
  consent: null,
  consentBusy: false,
  config: null,
  notice: null,
});

export const CONSENT_BUSY_KEY = 'consent';
export const PACKAGE_BUSY_KEY = 'package';
export const pluginBusyKey = (id: string) => `plugin:${id}`;

/** 不引入 i18n/通知单例的简单错误描述：Host 拒绝原因就是 Error.message。 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

const isEmptyDetail = (detail: string | undefined): boolean => !detail;

export class PluginManagerController {
  private _state: PluginManagerState = INITIAL_STATE;
  private readonly _listeners = new Set<() => void>();
  private _unsubscribeAdapter: (() => void) | undefined;
  private _refreshToken = 0;

  constructor(private readonly _adapter: PluginManagerAdapter) {}

  getSnapshot = (): PluginManagerState => this._state;

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  };

  /** 首次进入管理页：订阅 Host 推送并拉一次清单。重复调用是安全的。 */
  async start(): Promise<void> {
    if (!this._unsubscribeAdapter) {
      const unsubscribe = this._adapter.subscribe?.(() => {
        void this.refresh();
      });
      this._unsubscribeAdapter = unsubscribe ?? (() => undefined);
    }
    await this.refresh();
  }

  dispose(): void {
    this._unsubscribeAdapter?.();
    this._unsubscribeAdapter = undefined;
  }

  async refresh(): Promise<void> {
    const token = ++this._refreshToken;
    if (this._state.status !== 'ready') this.patch({ status: 'loading' });
    try {
      const snapshot = await this._adapter.list();
      if (token !== this._refreshToken) return;
      // 只清掉“清单读取失败”本身；重载/操作错误保留到用户看到为止。
      const error = this._state.error?.code === 'LIST_FAILED' ? null : this._state.error;
      this.patch({ status: 'ready', safeMode: snapshot.safeMode === true, platform: snapshot.platform, plugins: [...snapshot.plugins], error });
    } catch (error) {
      if (token !== this._refreshToken) return;
      this.patch({ status: 'error', error: { code: 'LIST_FAILED', detail: errorMessage(error) } });
    }
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.withBusy(pluginBusyKey(id), async () => {
      const result = await this._adapter.setEnabled(id, enabled);
      if (result.ok) {
        await this.refresh();
        this.patch({ notice: { kind: 'enabled-changed', pluginId: id, enabled } });
      }
      else this.applyOperationFailure(result);
    });
  }

  async uninstall(id: string): Promise<void> {
    await this.withBusy(pluginBusyKey(id), async () => {
      const result = await this._adapter.uninstall(id);
      if (result.ok) {
        if (this._state.config?.pluginId === id) this.patch({ config: null });
        await this.refresh();
      } else {
        this.applyOperationFailure(result);
      }
    });
  }

  async setTrust(subject: PluginConsentSubject, trust: 'full' | 'restricted'): Promise<void> {
    await this.withBusy(pluginBusyKey(subject.id), async () => {
      if (!this._adapter.setTrust) {
        this.patch({ error: { code: 'TRUST_UNAVAILABLE' } });
        return;
      }
      const result = await this._adapter.setTrust(subject, trust);
      if (result.ok) await this.refresh();
      else this.applyOperationFailure(result);
    });
  }

  /**
   * 用户点了同意：把**弹窗里展示的**主体交给 Host 写账本，然后整窗重载。
   * Host 仍必须自己核对主体与已安装包一致（避免过期确认），这里不做任何推断。
   */
  async grantConsent(): Promise<void> {
    const subject = this._state.consent;
    if (!subject || this._state.consentBusy) return;
    this.patch({ consentBusy: true });
    try {
      const result = await this._adapter.grantConsent(subject);
      if (!result.ok) {
        this.applyOperationFailure(result, { keepConsent: true });
        return;
      }
      this.patch({ consent: null, notice: { kind: 'consent-granted', pluginId: subject.id }, error: null });
      let reloadFailure: string | null = null;
      try {
        await this._adapter.reload();
      } catch (error) {
        reloadFailure = errorMessage(error);
      }
      await this.refresh();
      if (reloadFailure) this.patch({ error: { code: 'RELOAD_FAILED', detail: reloadFailure } });
    } catch (error) {
      this.patch({ error: { code: 'CONSENT_FAILED', detail: errorMessage(error) } });
    } finally {
      this.patch({ consentBusy: false });
    }
  }

  dismissConsent(): void {
    if (this._state.consentBusy) return;
    this.patch({ consent: null });
  }

  /**
   * 行内“处理同意”（W17 `hostStatus.consentRequired`）入口。
   *
   * 没有单独读取同意请求的命令：请 Host 启用/重新加载时，它会在导入社区代码前拒绝并返回带
   * 精确 id/version/permissions 的 `CONSENT_REQUIRED`；只有这个结果会打开弹窗，UI 不从安装包猜权限。
   */
  async requestConsent(id: string): Promise<void> {
    await this.withBusy(pluginBusyKey(id), async () => {
      const result = await this._adapter.setEnabled(id, true);
      if (succeeded(result)) await this.refresh();
      else this.applyOperationFailure(result);
    });
  }

  async installPackage(): Promise<void> {
    await this.withBusy(PACKAGE_BUSY_KEY, async () => {
      const result = await this._adapter.importPackage();
      if (!result) return; // System file picker cancelled; no failure or success notification.
      this.patch({ notice: { kind: 'package', result }, error: null,
        ...(result.status === 'installed' && result.consentRequired ? { consent: result.consentRequired } : {}) });
      await this.refresh();
    });
  }

  async openConfig(id: string): Promise<void> {
    this.patch({ config: { pluginId: id, status: 'loading' } });
    try {
      const config = await this._adapter.readConfig(id);
      if (this._state.config?.pluginId !== id) return;
      this.patch({ config: { pluginId: id, status: 'ready', config, saving: false, conflict: false } });
    } catch (error) {
      if (this._state.config?.pluginId !== id) return;
      this.patch({ config: { pluginId: id, status: 'error', message: errorMessage(error) } });
    }
  }

  closeConfig(): void {
    this.patch({ config: null });
  }

  /** 带修订号保存；失败结果原样交给表单（表单保留输入并显示字段错误）。 */
  async saveConfig(values: Readonly<Record<string, unknown>>, revision: PluginConfigRevision): Promise<PluginConfigSaveResult> {
    const view = this._state.config;
    if (!view || view.status !== 'ready') {
      return { ok: false, code: 'CONFIG_UNAVAILABLE', detail: 'config is not loaded' };
    }
    const savingView = { ...view, saving: true, message: undefined, issues: undefined };
    this.patch({ config: savingView });
    try {
      const result = await this._adapter.saveConfig(view.pluginId, values, revision);
      // 已关闭或切换配置（包括重新打开同一个插件）时，不回写旧视图。
      if (this._state.config !== savingView) return result;
      if (succeeded(result)) {
        this.patch({
          config: {
            pluginId: view.pluginId,
            status: 'ready',
            config: { schema: view.config.schema, values: result.values, revision: result.revision },
            saving: false,
            conflict: false,
          },
          notice: { kind: 'config-saved', pluginId: view.pluginId, revision: result.revision },
          error: null,
        });
        return result;
      }
      this.patch({
        config: {
          ...view,
          saving: false,
          conflict: result.code === 'REVISION_CONFLICT',
          message: result.detail ?? result.code,
          issues: result.issues,
        },
      });
      return result;
    } catch (error) {
      const detail = errorMessage(error);
      if (this._state.config === savingView) {
        this.patch({ config: { ...view, saving: false, conflict: false, message: detail } });
      }
      return { ok: false, code: 'SAVE_FAILED', detail };
    }
  }

  /** 修订号冲突后重新读取 Host 侧配置（表单内容由用户决定是否重填）。 */
  async reloadConfig(): Promise<void> {
    const view = this._state.config;
    if (!view) return;
    await this.openConfig(view.pluginId);
  }

  dismissNotice(): void {
    this.patch({ notice: null });
  }

  clearError(): void {
    if (this._state.error) this.patch({ error: null });
  }

  private applyOperationFailure(result: PluginOperationResult, options: { keepConsent?: boolean } = {}): void {
    if (succeeded(result)) return;
    if (result.code === 'CONSENT_REQUIRED' && 'consent' in result) {
      this.patch({ consent: result.consent, error: null });
      return;
    }
    if (!options.keepConsent && this._state.consent) this.patch({ consent: null });
    this.patch({
      error: {
        code: result.code,
        detail: 'detail' in result && !isEmptyDetail(result.detail) ? result.detail : undefined,
      },
    });
  }

  private async withBusy(key: string, action: () => Promise<void>): Promise<void> {
    if (this._state.busy.includes(key)) return;
    this.patch({ busy: [...this._state.busy, key], error: null });
    try {
      await action();
    } catch (error) {
      this.patch({ error: { code: 'OPERATION_FAILED', detail: errorMessage(error) } });
    } finally {
      this.patch({ busy: this._state.busy.filter((item) => item !== key) });
    }
  }

  private patch(patch: Partial<PluginManagerState>): void {
    this._state = { ...this._state, ...patch };
    for (const listener of [...this._listeners]) {
      try {
        listener();
      } catch (error) {
        console.error('[plugin-manager] listener failed', error);
      }
    }
  }
}

/** React 绑定：快照对象只在状态变化时替换，符合 useSyncExternalStore 的稳定性要求。 */
export function usePluginManagerState(controller: PluginManagerController): PluginManagerState {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}
