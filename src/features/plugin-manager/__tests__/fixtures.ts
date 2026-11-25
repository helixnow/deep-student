import type { PluginUiDegradedInfo, PluginUiAvailability, PluginUiHostState, PluginUiHostStatus } from '../ui-status';
import type {
  ManagedPlugin,
  PluginConfigSaveResult,
  PluginConfigRevision,
  PluginConfigState,
  PluginConsentSubject,
  PluginManagerAdapter,
  PluginManagerSnapshot,
  PluginOperationResult,
  PluginPackageResult,
  PluginPlatform,
  PluginProfileResetResult,
} from '../types';

export function managedPlugin(overrides: Partial<ManagedPlugin> = {}): ManagedPlugin {
  return {
    id: 'dstu.ui.example',
    version: '1.0.0',
    origin: 'builtin',
    platforms: ['desktop'],
    enabled: true,
    runtime: 'running',
    ...overrides,
  };
}

export interface AdapterCalls {
  list: number;
  setEnabled: Array<{ id: string; enabled: boolean }>;
  uninstall: string[];
  grantConsent: PluginConsentSubject[];
  reload: number;
  readConfig: string[];
  saveConfig: Array<{ id: string; values: Readonly<Record<string, unknown>>; revision: PluginConfigRevision }>;
  importPackage: number;
  installPackagePath: string[];
  installPackageFromUrl: string[];
  resetProfile: number;
}

/** 只记录调用的假适配器：测试里显式给出 Host 结果，不伪造命令名。 */
export class FakePluginManagerAdapter implements PluginManagerAdapter {
  plugins: ManagedPlugin[];
  platform: PluginPlatform = 'desktop';
  safeMode = false;
  profileCorrupted = false;
  profileError: string | undefined = undefined;
  readonly calls: AdapterCalls = {
    list: 0,
    setEnabled: [],
    uninstall: [],
    grantConsent: [],
    reload: 0,
    readConfig: [],
    saveConfig: [],
    importPackage: 0,
    installPackagePath: [],
    installPackageFromUrl: [],
    resetProfile: 0,
  };

  setEnabledResult: PluginOperationResult = { ok: true };
  setEnabledError: Error | null = null;
  uninstallResult: PluginOperationResult = { ok: true };
  grantConsentResult: PluginOperationResult = { ok: true };
  listError: Error | null = null;
  reloadError: Error | null = null;
  resetProfileResult: PluginProfileResetResult = {
    backedUpTo: '/data/plugins/user.profile.json.corrupt-20261125.bak',
    revision: 'profile-clean-1',
  };
  resetProfileError: Error | null = null;

  config: PluginConfigState = { schema: null, values: {}, revision: 1 };
  saveResult: PluginConfigSaveResult | null = null;
  packageResult: PluginPackageResult = {
    status: 'installed',
    id: 'community.example',
    version: '2.0.0',
    previousVersion: null,
    enabled: false,
  };

  private readonly listeners = new Set<() => void>();

  constructor(plugins: ManagedPlugin[] = []) {
    this.plugins = plugins;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Host 推送清单变化。 */
  emitChange(): void {
    for (const listener of [...this.listeners]) listener();
  }

  async list(): Promise<PluginManagerSnapshot> {
    this.calls.list += 1;
    if (this.listError) throw this.listError;
    return {
      platform: this.platform,
      ...(this.safeMode ? { safeMode: true } : {}),
      ...(this.profileCorrupted ? { profileCorrupted: true } : {}),
      ...(this.profileError ? { profileError: this.profileError } : {}),
      plugins: this.plugins,
    };
  }

  async resetProfile(): Promise<PluginProfileResetResult> {
    this.calls.resetProfile += 1;
    if (this.resetProfileError) throw this.resetProfileError;
    this.profileCorrupted = false;
    this.profileError = undefined;
    this.listError = null;
    return this.resetProfileResult;
  }

  async setEnabled(id: string, enabled: boolean): Promise<PluginOperationResult> {
    this.calls.setEnabled.push({ id, enabled });
    if (this.setEnabledError) throw this.setEnabledError;
    return this.setEnabledResult;
  }

  async uninstall(id: string): Promise<PluginOperationResult> {
    this.calls.uninstall.push(id);
    return this.uninstallResult;
  }

  async grantConsent(subject: PluginConsentSubject): Promise<PluginOperationResult> {
    this.calls.grantConsent.push(subject);
    return this.grantConsentResult;
  }

  async reload(): Promise<void> {
    this.calls.reload += 1;
    if (this.reloadError) throw this.reloadError;
  }

  async readConfig(id: string): Promise<PluginConfigState> {
    this.calls.readConfig.push(id);
    return this.config;
  }

  async saveConfig(
    id: string,
    values: Readonly<Record<string, unknown>>,
    revision: PluginConfigRevision,
  ): Promise<PluginConfigSaveResult> {
    this.calls.saveConfig.push({ id, values, revision });
    if (this.saveResult) return this.saveResult;
    return { ok: true, values, revision: typeof revision === 'number' ? revision + 1 : `${revision}:next` };
  }

  async importPackage(): Promise<PluginPackageResult> {
    this.calls.importPackage += 1;
    return this.packageResult;
  }

  async installPackagePath(path: string): Promise<PluginPackageResult> {
    this.calls.installPackagePath.push(path);
    return this.packageResult;
  }

  async installPackageFromUrl(url: string): Promise<PluginPackageResult> {
    this.calls.installPackageFromUrl.push(url);
    return this.packageResult;
  }
}

/**
 * W17 `UiHostStatusHandle` 的测试替身：只保存测试显式给的结构化结果，
 * 不复制 W17 的解析实现（真实解析由 W17 的 host-status 测试覆盖）。
 */
export class FakePluginUiHostStatus implements PluginUiHostStatus {
  known = true;
  safeMode = false;
  private installed = new Set<string>();
  private degradedById = new Map<string, PluginUiDegradedInfo>();
  private readonly listeners = new Set<() => void>();

  constructor(installed: readonly string[] = []) {
    for (const id of installed) this.installed.add(id);
  }

  setInstalled(ids: readonly string[]): void {
    this.installed = new Set(ids);
    this.emit();
  }

  setSafeMode(value: boolean): void {
    if (this.safeMode === value) return;
    this.safeMode = value;
    this.emit();
  }

  setDegraded(id: string, info: PluginUiDegradedInfo | null): void {
    if (info) this.degradedById.set(id, info);
    else this.degradedById.delete(id);
    this.emit();
  }

  state(hostId: string): PluginUiHostState {
    if (this.degradedById.has(hostId)) return 'degraded';
    if (!this.known) return 'unknown';
    return this.installed.has(hostId) ? 'online' : 'missing';
  }

  reason(hostId: string): string | undefined {
    return this.degradedById.get(hostId)?.detail;
  }

  degraded(hostId: string): PluginUiDegradedInfo | undefined {
    return this.degradedById.get(hostId);
  }

  consentRequired(hostId: string): boolean {
    return this.degradedById.get(hostId)?.consentRequired === true;
  }

  availability(hostIds: readonly string[]): PluginUiAvailability {
    const states = hostIds.map((id) => this.state(id));
    if (states.includes('missing')) return 'missing';
    if (states.includes('degraded')) return 'degraded';
    return 'available';
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
