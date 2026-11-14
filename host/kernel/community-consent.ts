/** Host-owned K3 ledger. Authorization belongs to the trusted kernel command, not its payload. */
// RUST-FIX(RF-W32-community-consent-ledger): Rust 没有社区插件安装流程与同意记录（src-tauri/src/plugins/manager.rs 只管内置插件的启停），
// 任何能写 plugins 目录的人都能在下次启动时执行代码；这里新增 Host 侧的安装前同意账本。
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export interface ConsentSubject {
  readonly id: string;
  readonly version: string;
  readonly permissions: readonly string[];
}

export interface CommunityConsentRecord extends ConsentSubject {
  readonly permissionsDigest: string;
  readonly trust: PluginTrust;
  readonly source: CommunityPluginSource;
}

export type PluginTrust = 'full' | 'restricted';
// RUST-FIX(RF-P1-plugin-trust): Provenance comes from the Host transaction, never package metadata.
export type CommunityPluginSource = 'workshop' | 'package';

export interface ConsentDecision {
  matched: boolean;
  code: 'CONSENT_REQUIRED' | null;
  reason: 'missing' | 'version' | 'permissions' | null;
  /** Intersection only; a non-matching decision still forbids loading. */
  grantedPermissions: readonly string[];
  trust?: PluginTrust;
  source?: CommunityPluginSource;
}

export function canonicalPermissions(permissions: readonly string[]): string[] {
  if (!Array.isArray(permissions) || permissions.some(p => typeof p !== 'string' || !p || p.trim() !== p)) {
    throw new TypeError('consent permissions must be non-empty exact strings');
  }
  return [...new Set(permissions)].sort();
}

export function permissionsDigest(permissions: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(canonicalPermissions(permissions))).digest('hex');
}

function recordFor(subject: ConsentSubject, options: { trust?: PluginTrust; source?: CommunityPluginSource } = {}): CommunityConsentRecord {
  if (typeof subject.id !== 'string' || !subject.id || typeof subject.version !== 'string' || !subject.version) {
    throw new TypeError('consent requires plugin id and version');
  }
  const permissions = canonicalPermissions(subject.permissions);
  if (options.trust !== undefined && options.trust !== 'full' && options.trust !== 'restricted') throw new TypeError('invalid plugin trust');
  if (options.source !== undefined && options.source !== 'workshop' && options.source !== 'package') throw new TypeError('invalid plugin source');
  return { id: subject.id, version: subject.version, permissions, permissionsDigest: permissionsDigest(permissions), trust: options.trust ?? 'restricted', source: options.source ?? 'package' };
}

function parseRecords(text: string): CommunityConsentRecord[] {
  const value = JSON.parse(text);
  if (value?.schemaVersion !== 1 || !Array.isArray(value.records)) throw new Error('invalid community consent ledger');
  const ids = new Set<string>();
  return value.records.map((item: CommunityConsentRecord) => {
    const record = recordFor(item, item);
    if (record.permissionsDigest !== item.permissionsDigest || ids.has(record.id)) throw new Error('invalid community consent record');
    ids.add(record.id);
    return record;
  });
}

// One Host owns dataDir. Serialize read-modify-write even across ledger instances in that Host.
const writes = new Map<string, Promise<unknown>>();

export class CommunityConsentLedger {
  readonly path: string;

  constructor(dataDir: string) {
    this.path = resolve(dataDir, 'community-consent.json');
  }

  async read(): Promise<readonly CommunityConsentRecord[]> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return parseRecords(text);
  }

  async evaluate(subject: ConsentSubject): Promise<ConsentDecision> {
    const requested = recordFor(subject);
    const previous = (await this.read()).find(record => record.id === requested.id);
    const approved = new Set(previous?.permissions ?? []);
    const reason = !previous ? 'missing' : previous.version !== requested.version ? 'version'
      : previous.permissionsDigest !== requested.permissionsDigest ? 'permissions' : null;
    return {
      matched: reason === null,
      code: reason === null ? null : 'CONSENT_REQUIRED',
      reason,
      grantedPermissions: requested.permissions.filter(permission => approved.has(permission)),
      trust: previous?.trust ?? 'restricted',
      source: previous?.source ?? 'package',
    };
  }

  /** Call only after trusted main-window/local-origin authorization and manifest confirmation. */
  async grant(subject: ConsentSubject, options: { trust?: PluginTrust; source?: CommunityPluginSource } = {}): Promise<CommunityConsentRecord> {
    return this.writeRecord(subject, options, false) as Promise<CommunityConsentRecord>;
  }

  /** Host transaction rollback; removes only this subject's record, retaining all other IDs. */
  async restore(id: string, previous: CommunityConsentRecord | undefined): Promise<void> {
    // RUST-FIX(RF-P1-managed-plugin-install): Restore consent together with the active release on transaction failure.
    if (previous) { await this.grant(previous, previous); return; }
    await this.writeRecord({ id, version: '0.0.0', permissions: [] }, {}, true);
  }

  private async writeRecord(subject: ConsentSubject, options: { trust?: PluginTrust; source?: CommunityPluginSource }, remove: boolean): Promise<CommunityConsentRecord | undefined> {
    const step = async () => {
      const previousRecords = await this.read();
      const previous = previousRecords.find(item => item.id === subject.id);
      const record = recordFor(subject, { trust: options.trust ?? previous?.trust, source: options.source ?? previous?.source });
      const records = previousRecords.filter(previous => previous.id !== record.id);
      if (!remove) records.push(record);
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, 'wx', 0o600);
        try {
          await file.writeFile(JSON.stringify({ schemaVersion: 1, records }) + '\n', 'utf8');
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, this.path);
      } finally {
        await unlink(temporary).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
      }
      return remove ? undefined : record;
    };
    // Run after the previous write settles, whether it succeeded or failed.
    const pending = (writes.get(this.path) ?? Promise.resolve()).then(step, step);
    writes.set(this.path, pending);
    try {
      return await pending;
    } finally {
      if (writes.get(this.path) === pending) writes.delete(this.path);
    }
  }
}
