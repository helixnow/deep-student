/**
 * Portable backup config types, serde-compatible JSON codec, and path helpers.
 * Zero `node:*` dependencies — shared between desktop `backup-config.ts` and mobile `settings/mobile.ts`.
 */
import { AppError, type AppError as AppErrorValue } from '../errors/api.ts';
import { JsonReader } from '../util/index.ts';
import { posix } from '../util/path.ts';

/** `BackupConfig`（`backup_config.rs:28–53`）。`backupTiers === undefined` = Rust `None`（省略字段）。 */
export interface BackupConfig {
  backupDirectory: string | null;
  autoBackupEnabled: boolean;
  autoBackupIntervalHours: number;
  maxBackupCount: number | null;
  slimBackup: boolean;
  backupTiers?: BackupTier[];
}

/** `BackupTier` 的线上值（`dstu-sync/.../backup/mod.rs:1935–1945`）。 */
export type BackupTier = 'core' | 'important' | 'rebuildable' | 'large_assets';

/** `AutoBackupStatus`（`backup_config.rs:204–212`）。 */
export interface AutoBackupStatus {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  nextDueAt: string | null;
  lastJobId: string | null;
}

/** 与 Rust `BackupConfig::default()`（`backup_config.rs:59–70`）相同。 */
export function defaultBackupConfig(): BackupConfig {
  return {
    backupDirectory: null,
    autoBackupEnabled: false,
    autoBackupIntervalHours: 24,
    maxBackupCount: 5,
    slimBackup: false,
  };
}

/** 与 Rust `AutoBackupStatus::default()`（`#[derive(Default)]`）相同。 */
export function defaultAutoBackupStatus(): AutoBackupStatus {
  return { lastAttemptAt: null, lastSuccessAt: null, lastError: null, nextDueAt: null, lastJobId: null };
}

/** 携带 Rust `AppError` 形状的配置错误，命令层原样转换成 `CommandError`。 */
export class BackupConfigError extends Error {
  readonly appError: AppErrorValue;
  constructor(appError: AppErrorValue, options?: { cause?: unknown }) {
    super(appError.message, options);
    this.name = 'BackupConfigError';
    this.appError = appError;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function internal(prefix: string, error: unknown): BackupConfigError {
  return new BackupConfigError(AppError.internal(`${prefix}: ${message(error)}`), { cause: error });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const TIER_ALIASES: Readonly<Record<string, BackupTier>> = {
  core: 'core',
  core_config_chat: 'core',
  important: 'important',
  vfs_full: 'important',
  rebuildable: 'rebuildable',
  large_assets: 'large_assets',
  large_files: 'large_assets',
};

const TIER_VARIANTS = '`core`, `important`, `rebuildable`, `large_assets`';

/** `BackupTier`（snake_case + alias）：字符串，或 externally-tagged `{ "variant": null }`。 */
function readTier(r: JsonReader): BackupTier {
  const variant = (name: string): BackupTier => {
    if (Object.hasOwn(TIER_ALIASES, name)) return TIER_ALIASES[name]!;
    throw r.error(`unknown variant \`${name}\`, expected one of ${TIER_VARIANTS}`);
  };
  if (r.peekKind() === 'string') return variant(r.readString());
  r.beginObject('string or map');
  const name = r.readEnumVariant();
  const tier = variant(name);
  r.readNull('unit');
  r.endEnumObject();
  return tier;
}

const BACKUP_CONFIG_FIELDS = ['backupDirectory', 'autoBackupEnabled', 'autoBackupIntervalHours', 'maxBackupCount', 'slimBackup', 'backupTiers'];
const AUTO_BACKUP_STATUS_FIELDS = ['lastAttemptAt', 'lastSuccessAt', 'lastError', 'nextDueAt', 'lastJobId'] as const;

/**
 * `serde_json::from_str::<BackupConfig>`（`backup_config.rs:28-52`，derive，无 deny_unknown_fields）。
 */
export function parseBackupConfig(json: string): BackupConfig {
  try {
    const r = new JsonReader(json);
    const config: BackupConfig = {
      backupDirectory: null, autoBackupEnabled: false, autoBackupIntervalHours: 24, maxBackupCount: null, slimBackup: false,
    };
    const readField = (key: string): void => {
      switch (key) {
        case 'backupDirectory': config.backupDirectory = r.readOptionNone() ? null : r.readString(); break;
        case 'autoBackupEnabled': config.autoBackupEnabled = r.readBool(); break;
        case 'autoBackupIntervalHours': config.autoBackupIntervalHours = Number(r.readUnsigned('u32', 0xffff_ffffn)); break;
        case 'maxBackupCount': config.maxBackupCount = r.readOptionNone() ? null : Number(r.readUnsigned('u32', 0xffff_ffffn)); break;
        case 'slimBackup': config.slimBackup = r.readBool(); break;
        case 'backupTiers': {
          if (r.readOptionNone()) break;
          r.beginArray();
          const tiers: BackupTier[] = [];
          while (r.nextItem()) tiers.push(readTier(r));
          config.backupTiers = tiers;
          break;
        }
      }
    };
    if (r.peekKind() === 'array') {
      r.beginArray();
      let closed = false;
      for (const key of BACKUP_CONFIG_FIELDS) {
        if (!r.nextItem()) { closed = true; break; }
        readField(key);
      }
      if (!closed) r.endArray();
    } else {
      r.beginObject('struct BackupConfig');
      const seen = new Set<string>();
      for (let key = r.nextKey(); key !== null; key = r.nextKey()) {
        if (!BACKUP_CONFIG_FIELDS.includes(key)) { r.skipIgnoredValue(); continue; }
        if (seen.has(key)) throw r.fieldError(`duplicate field \`${key}\``);
        seen.add(key);
        readField(key);
      }
    }
    r.end();
    return config;
  } catch (error) {
    throw internal('解析备份配置失败', error);
  }
}

/** `serde_json::to_string::<BackupConfig>` 的等价输出（字段顺序、`skip_serializing_if` 相同）。 */
export function serializeBackupConfig(config: BackupConfig): string {
  const out: Record<string, unknown> = {
    backupDirectory: config.backupDirectory ?? null,
    autoBackupEnabled: config.autoBackupEnabled,
    autoBackupIntervalHours: config.autoBackupIntervalHours,
    maxBackupCount: config.maxBackupCount ?? null,
    slimBackup: config.slimBackup,
  };
  if (config.backupTiers !== undefined && config.backupTiers !== null) out.backupTiers = [...config.backupTiers];
  return JSON.stringify(out);
}

/** 反序列化命令行参数（`BackupConfig__De`）时补齐默认值并规范化 BackupTier 别名。 */
export function normalizeBackupConfig(value: unknown): BackupConfig {
  if (!isRecord(value)) throw internal('解析备份配置失败', new Error('expected a JSON object'));
  return parseBackupConfig(JSON.stringify(value));
}

/** `serde_json::from_str::<AutoBackupStatus>`；失败文案与 `AutoBackupStatus::load` 相同。 */
export function parseAutoBackupStatus(json: string): AutoBackupStatus {
  try {
    const r = new JsonReader(json);
    const status: AutoBackupStatus = { lastAttemptAt: null, lastSuccessAt: null, lastError: null, nextDueAt: null, lastJobId: null };
    const readField = (field: typeof AUTO_BACKUP_STATUS_FIELDS[number]): void => {
      status[field] = r.readOptionNone() ? null : r.readString();
    };
    if (r.peekKind() === 'array') {
      r.beginArray();
      for (const [index, field] of AUTO_BACKUP_STATUS_FIELDS.entries()) {
        if (!r.nextItem()) throw r.error(`invalid length ${index}, expected struct AutoBackupStatus with 5 elements`);
        readField(field);
      }
      r.endArray();
    } else {
      r.beginObject('struct AutoBackupStatus');
      const seen = new Set<string>();
      for (let key = r.nextKey(); key !== null; key = r.nextKey()) {
        const field = AUTO_BACKUP_STATUS_FIELDS.find(name => name === key);
        if (field === undefined) { r.skipIgnoredValue(); continue; }
        if (seen.has(field)) throw r.fieldError(`duplicate field \`${field}\``);
        seen.add(field);
        readField(field);
      }
    }
    r.end();
    return status;
  } catch (error) {
    throw internal('解析自动备份状态失败', error);
  }
}

/** `serde_json::to_string::<AutoBackupStatus>`（`backup_config.rs:223–228`）：字段顺序与 Rust 相同，`None` 写 null。 */
export function serializeAutoBackupStatus(status: AutoBackupStatus): string {
  return JSON.stringify({
    lastAttemptAt: status.lastAttemptAt,
    lastSuccessAt: status.lastSuccessAt,
    lastError: status.lastError,
    nextDueAt: status.nextDueAt,
    lastJobId: status.lastJobId,
  });
}

/** Portable recovery backup dir derivation for POSIX / OPFS roots (`<base>/recovery/backups`). */
export function defaultRecoveryBackupDirPortable(runtimeRoot: string): string {
  const root = posix.normalize(runtimeRoot);
  const parent = posix.dirname(root);
  const base = posix.basename(parent) === 'slots' ? posix.dirname(parent) : root;
  return posix.join(base, 'recovery', 'backups');
}
