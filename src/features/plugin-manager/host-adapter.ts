/** W01 seven-command handoff. No channel-plugin commands or invented reload command. */
import type {
  PluginManagerInventory, PluginManagerConfigView, PluginManagerInstallResult,
} from '../../../host/kernel/core';
import type { ConfigSchemaProjection } from '../../../host/kernel/config-schema';
import { succeeded } from './result';
import type {
  PluginManagerAdapter, PluginConfigRevision, PluginConfigSaveResult, PluginConfigState,
  PluginConfigSchemaNode, PluginConsentSubject, PluginOperationResult, PluginPackageResult, PluginPlatform,
} from './types';

export const MANAGER_COMMANDS = {
  list: 'plugin:manager|list', config: 'plugin:manager|config', save: 'plugin:manager|config|save',
  setEnabled: 'plugin:manager|set-enabled', uninstall: 'plugin:manager|uninstall',
  consent: 'plugin:manager|consent', install: 'plugin:manager|install',
  setTrust: 'plugin:manager|set-trust',
} as const;

export interface PluginManagerTransport {
  invoke<T>(command: string, args: Record<string, unknown>): Promise<T>;
  choosePackage(): Promise<string | null>;
  platform: PluginPlatform;
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Electron rejects AppError objects; some shell versions serialize that same object as JSON. */
export function managerError(error: unknown): { code: string; detail: string; details?: Record<string, unknown> } {
  if (typeof error === 'string') {
    try { return managerError(JSON.parse(error)); } catch { /* plain prefixed message */ }
  }
  const record = object(error);
  const detail = typeof record?.message === 'string' ? record.message : String(error);
  const details = object(record?.details);
  const code = typeof details?.code === 'string' ? details.code : /^([A-Z][A-Z0-9_]+):/.exec(detail)?.[1] ?? 'OPERATION_FAILED';
  return { code, detail, details };
}

function consentSubject(details: Record<string, unknown> | undefined, id: string): PluginConsentSubject | undefined {
  if (!details || details.id !== id || typeof details.version !== 'string' ||
      !Array.isArray(details.permissions) || !details.permissions.every((p) => typeof p === 'string')) return;
  return { id, version: details.version, permissions: details.permissions as string[] };
}

/** Consume Host's flat projection; hidden/unsupported values are preserved in the original values object. */
export function managerSchema(schema: ConfigSchemaProjection | null): PluginConfigSchemaNode | null {
  if (!schema) return null;
  const dict: Record<string, PluginConfigSchemaNode> = {};
  for (const field of schema.fields) {
    if (field.hidden) continue;
    const meta = { description: field.description, default: field.default, required: field.required,
      pattern: field.pattern, min: field.min, max: field.max, step: field.step };
    if (!field.disabled && ['boolean', 'string', 'number'].includes(field.type)) {
      dict[field.path] = { type: field.type as 'boolean' | 'string' | 'number', meta };
    } else if (!field.disabled && field.type === 'enum' && field.options?.length) {
      dict[field.path] = { type: 'union', meta, list: field.options.map((value) => ({ type: 'const', value })) };
    } else {
      dict[field.path] = { type: 'object', dict: {}, meta }; // Not editable; ConfigForm explicitly reports it.
    }
  }
  return { type: 'object', dict };
}

export class HostPluginManagerAdapter implements PluginManagerAdapter {
  subscribe?: (listener: () => void) => () => void;
  private revision: string | null = null;
  private inventory: PluginManagerInventory | undefined;
  private consented: string | undefined;

  constructor(private readonly transport: PluginManagerTransport) {}

  async list() {
    const inventory = await this.transport.invoke<PluginManagerInventory>(MANAGER_COMMANDS.list, {});
    this.inventory = inventory;
    this.revision = inventory.revision;
    return { platform: this.transport.platform, safeMode: inventory.safeMode, plugins: inventory.plugins.map((entry) => {
      return ({
      id: entry.id, origin: entry.origin, version: entry.version ?? '—', platforms: entry.platforms,
      displayName: entry.displayName, displayNameKey: entry.displayNameKey, descriptionKey: entry.descriptionKey,
      description: entry.description, icon: entry.icon, author: entry.author, category: entry.category, homepage: entry.homepage,
      trust: entry.trust, source: entry.source, permissions: entry.permissions,
      enabled: entry.enabled,
      runtime: entry.state === 'running' ? 'running' as const : entry.state === 'degraded' ? 'error' as const : 'stopped' as const,
      ...(entry.reason ? { degraded: { reason: entry.reason } } : {}),
      consent: entry.consent ? entry.consent.matched ? 'granted' as const : 'required' as const : 'unknown' as const,
      configurable: entry.hasConfig,
    }); }) };
  }

  async setTrust(subject: PluginConsentSubject, trust: 'full' | 'restricted'): Promise<PluginOperationResult> {
    try {
      await this.transport.invoke(MANAGER_COMMANDS.setTrust, { id: subject.id, version: subject.version, permissions: subject.permissions, trust, confirmed: true });
      await this.list();
      return { ok: true };
    } catch (error) { return this.failure(error, subject.id); }
  }

  private async profileRevision(): Promise<string> {
    if (!this.revision) await this.list();
    if (!this.revision) throw new Error('PROFILE_READ_FAILED: no writable profile revision');
    return this.revision;
  }

  private async failure(error: unknown, id?: string): Promise<PluginOperationResult> {
    const parsed = managerError(error);
    // A failed mutation may have rolled back to a new CAS token. Never retry using an old revision.
    await this.list().catch((refreshError) => { console.warn('[plugin-manager] failed to refresh after mutation error', refreshError); });
    const subject = id && parsed.code === 'CONSENT_REQUIRED' ? consentSubject(parsed.details, id) : undefined;
    return subject ? { ok: false, code: 'CONSENT_REQUIRED', consent: subject }
      : { ok: false, code: parsed.code, detail: parsed.detail };
  }

  async setEnabled(id: string, enabled: boolean): Promise<PluginOperationResult> {
    try {
      const result = await this.transport.invoke<{ revision: string }>(MANAGER_COMMANDS.setEnabled,
        { id, enabled, revision: await this.profileRevision() });
      this.revision = result.revision;
      return { ok: true };
    } catch (error) { return this.failure(error, id); }
  }

  async uninstall(id: string): Promise<PluginOperationResult> {
    try {
      const result = await this.transport.invoke<{ revision: string }>(MANAGER_COMMANDS.uninstall,
        { id, revision: await this.profileRevision() });
      this.revision = result.revision;
      return { ok: true };
    } catch (error) { return this.failure(error, id); }
  }

  async grantConsent(subject: PluginConsentSubject): Promise<PluginOperationResult> {
    try {
      await this.transport.invoke(MANAGER_COMMANDS.consent, { id: subject.id, version: subject.version, permissions: subject.permissions });
      this.consented = subject.id;
      return { ok: true };
    } catch (error) { return this.failure(error, subject.id); }
  }

  /** The published Host has no reload command. Reconcile then enable the explicitly consented plugin. */
  async reload(): Promise<void> {
    const id = this.consented;
    this.consented = undefined;
    await this.list();
    if (!id) return;
    const result = await this.setEnabled(id, true);
    if (!succeeded(result)) throw new Error('detail' in result ? result.detail ?? result.code : result.code);
  }

  async readConfig(id: string): Promise<PluginConfigState> {
    const result = await this.transport.invoke<PluginManagerConfigView>(MANAGER_COMMANDS.config, { id });
    this.revision = result.revision;
    if (!result.revision) throw new Error('PROFILE_READ_FAILED: config has no profile revision');
    return { schema: managerSchema(result.schema), values: object(result.values) ?? {}, revision: result.revision };
  }

  async saveConfig(id: string, values: Readonly<Record<string, unknown>>, revision: PluginConfigRevision): Promise<PluginConfigSaveResult> {
    try {
      // Pass the token from the open config view, NOT the newer inventory token. Host owns CAS.
      await this.transport.invoke(MANAGER_COMMANDS.save, { id, values, revision });
      const current = await this.readConfig(id); // Read back validated defaults / hot-applied values, not the draft.
      return { ok: true, values: current.values, revision: current.revision };
    } catch (error) {
      const parsed = managerError(error);
      await this.list().catch((refreshError) => { console.warn('[plugin-manager] failed to refresh after configuration error', refreshError); });
      return { ok: false, code: parsed.code === 'PROFILE_CONFLICT' ? 'REVISION_CONFLICT' : parsed.code, detail: parsed.detail };
    }
  }

  async importPackage(): Promise<PluginPackageResult | null> {
    const path = await this.transport.choosePackage();
    if (!path) return null;
    try {
      const revision = await this.profileRevision();
      const previous = this.inventory;
      const result = await this.transport.invoke<PluginManagerInstallResult>(MANAGER_COMMANDS.install, { path, revision });
      this.revision = result.revision;
      return { status: 'installed', id: result.id, version: result.version, enabled: result.enabled,
        previousVersion: previous?.plugins.find((entry) => entry.id === result.id)?.version ?? null,
        consentRequired: result.consentRequired };
    } catch (error) {
      const parsed = managerError(error);
      await this.list().catch((refreshError) => { console.warn('[plugin-manager] failed to refresh after package error', refreshError); });
      return { status: 'rejected', code: parsed.code, detail: parsed.detail,
        rollback: parsed.details?.rollback === 'failed' ? 'failed' : parsed.details?.rollback === 'restored' ? 'restored' : 'unchanged' };
    }
  }
}

/** System dialog and invoke use the app shell's existing Tauri-compatible production bridge. */
export function createHostPluginManagerAdapter(platform: PluginPlatform): HostPluginManagerAdapter {
  return new HostPluginManagerAdapter({
    platform,
    async invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
      const { invoke } = await import('@tauri-apps/api/core');
      // Keep the production bridge statically auditable by frontend-invoke/F1, without a dynamic-command whitelist.
      switch (command) {
        case MANAGER_COMMANDS.list: return invoke<T>('plugin:manager|list', {});
        case MANAGER_COMMANDS.config: return invoke<T>('plugin:manager|config', { id: args.id });
        case MANAGER_COMMANDS.save: return invoke<T>('plugin:manager|config|save', { id: args.id, values: args.values, revision: args.revision });
        case MANAGER_COMMANDS.setEnabled: return invoke<T>('plugin:manager|set-enabled', { id: args.id, enabled: args.enabled, revision: args.revision });
        case MANAGER_COMMANDS.uninstall: return invoke<T>('plugin:manager|uninstall', { id: args.id, revision: args.revision });
        case MANAGER_COMMANDS.consent: return invoke<T>('plugin:manager|consent', { id: args.id, version: args.version, permissions: args.permissions });
        case MANAGER_COMMANDS.install: return invoke<T>('plugin:manager|install', { path: args.path, revision: args.revision });
        case MANAGER_COMMANDS.setTrust: return invoke<T>('plugin:manager|set-trust', { id: args.id, version: args.version, permissions: args.permissions, trust: args.trust, confirmed: true });
        default: throw new Error(`Unsupported plugin manager command: ${command}`);
      }
    },
    choosePackage: () => import('@tauri-apps/plugin-dialog').then(({ open }) => open({
      multiple: false, directory: false, filters: [{ name: 'Deep Student Plugin', extensions: ['dstuplugin'] }],
    })).then((path) => typeof path === 'string' ? path : null),
  });
}
