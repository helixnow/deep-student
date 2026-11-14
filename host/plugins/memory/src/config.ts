import type { AutoExtractFrequency, EvolutionTuning } from '../api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { getConfigValue, setConfigValue } from '../repository/config.ts';
import {
  createFolder, findSyncedMemoryRoot, folderExists, getFolder, listFoldersByParent,
  listItemsByFolder, moveFolder, moveItemToFolder, softDeleteFolder,
  type MemoryVfsDependencies,
} from '../repository/vfs.ts';
import { f32 } from './f32.ts';

export const CONFIG_KEYS = {
  rootFolderId: 'memory_root_folder_id', autoCreateSubfolders: 'auto_create_subfolders',
  defaultCategory: 'default_category', privacyMode: 'privacy_mode',
  autoExtractFrequency: 'auto_extract_frequency',
  stale_hit_days: 'evolution_stale_hit_days', stale_injected_days: 'evolution_stale_injected_days',
  stale_min_hits: 'evolution_stale_min_hits', archive_after_stale_days: 'evolution_archive_after_stale_days',
  category_quota: 'evolution_category_quota', semantic_merge_max_pairs: 'evolution_semantic_merge_max_pairs',
  semantic_merge_min_score: 'evolution_semantic_merge_min_score',
  semantic_dedup_interval_minutes: 'evolution_semantic_dedup_interval_minutes',
} as const;
export const DEFAULT_FOLDER_TITLE = '记忆';
export const DEFAULT_EVOLUTION_TUNING: Readonly<EvolutionTuning> = {
  stale_hit_days: 90, stale_injected_days: 180, stale_min_hits: 2,
  archive_after_stale_days: 90, category_quota: 50, semantic_merge_max_pairs: 3,
  semantic_merge_min_score: f32(0.35), semantic_dedup_interval_minutes: 360,
};

export function frequencyFromStrLossy(value: string,
  warn: (message: string) => void = () => undefined): AutoExtractFrequency {
  if (value === 'off' || value === 'balanced' || value === 'aggressive') return value;
  warn(`[Memory::Config] Unknown auto_extract_frequency '${value}', defaulting to Balanced`);
  return 'balanced';
}
export function contentMinChars(frequency: AutoExtractFrequency): number {
  return frequency === 'off' ? Number(0xffffffffffffffffn) : frequency === 'balanced' ? 10 : 4;
}
export function shouldRefreshCategories(frequency: AutoExtractFrequency, count: number): boolean {
  return frequency === 'aggressive' || (frequency === 'balanced' && (count <= 5 || count % 5 === 0));
}
export function evolutionIntervalMs(frequency: AutoExtractFrequency): number {
  return (frequency === 'off' ? 1440 : frequency === 'balanced' ? 30 : 15) * 60 * 1000;
}

export class MemoryConfig {
  readonly _database: () => SqlExecutor;
  readonly _deps: () => MemoryVfsDependencies;
  readonly _warn: (message: string) => void;
  constructor(database: () => SqlExecutor, dependencies: () => MemoryVfsDependencies,
    warn: (message: string) => void = () => undefined) {
    this._database = database;
    this._deps = dependencies;
    this._warn = warn;
  }
  get(key: string): string | null { return getConfigValue(this._database(), key); }
  set(key: string, value: string): void { setConfigValue(this._database(), key, value); }
  getAutoExtractFrequency(): AutoExtractFrequency {
    return frequencyFromStrLossy(this.get(CONFIG_KEYS.autoExtractFrequency) ?? 'balanced',
      this._warn);
  }
  getRootFolderId(): string | null { return this.get(CONFIG_KEYS.rootFolderId); }
  setRootFolderId(folderId: string): void { this.set(CONFIG_KEYS.rootFolderId, folderId); }
  /** Rust `MemoryConfig::get_or_create_root_folder` (J8a synced-root claim included). */
  getOrCreateRootFolder(): string {
    const db = this._database();
    const configured = this.getRootFolderId();
    if (configured !== null && folderExists(db, configured)) {
      this.repairNestedRootDuplicatesOnce(configured);
      return configured;
    }
    if (configured !== null) {
      this._warn(`[Memory::Config] Configured folder ${configured} not found, creating new one`);
    }
    const synced = findSyncedMemoryRoot(db, this._warn);
    if (synced !== null) {
      this.setRootFolderId(synced);
      this.repairNestedRootDuplicatesOnce(synced);
      return synced;
    }
    const folder = createFolder(this._deps(), db, DEFAULT_FOLDER_TITLE, null);
    this.setRootFolderId(folder.id);
    return folder.id;
  }

  private readonly repairedRoots = new Set<string>();

  /** Rust `repair_nested_root_duplicates_once`: process-wide once per root. */
  private repairNestedRootDuplicatesOnce(rootId: string): void {
    if (this.repairedRoots.has(rootId)) return;
    this.repairedRoots.add(rootId);
    try {
      this.repairNestedRootDuplicates(rootId);
    } catch (error) {
      // Rust logs a warning and retries on the next process start.
      this._warn(`[Memory] Nested root repair failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Rust `repair_nested_root_duplicates`: merge `记忆/记忆/...` back into the root. */
  repairNestedRootDuplicates(rootId: string): number {
    const db = this._database();
    const root = getFolder(db, rootId);
    if (root === undefined) return 0;
    const rootTitle = root.title.trim();
    if (rootTitle === '') return 0;

    let merged = 0;
    for (let pass = 0; pass < 16; pass += 1) {
      const duplicate = listFoldersByParent(db, rootId)
        .find(folder => folder.title.trim() === rootTitle);
      if (duplicate === undefined) break;
      this.mergeFolderInto(duplicate.id, rootId);
      merged += 1;
    }
    return merged;
  }

  /** Rust `merge_folder_into_with_conn`. */
  private mergeFolderInto(srcId: string, dstId: string): void {
    const db = this._database();
    for (const child of listFoldersByParent(db, srcId)) {
      const existing = listFoldersByParent(db, dstId)
        .find(folder => folder.id !== srcId && folder.title === child.title);
      if (existing !== undefined) this.mergeFolderInto(child.id, existing.id);
      else moveFolder(this._deps(), db, child.id, dstId);
    }
    for (const item of listItemsByFolder(db, srcId)) {
      moveItemToFolder(this._deps(), db, item.itemType, item.itemId, dstId);
    }
    softDeleteFolder(this._deps(), db, srcId);
  }
  getRootFolderTitle(): string | null {
    const id = this.getRootFolderId();
    return id === null ? null : getFolder(this._database(), id)?.title ?? null;
  }
  createRootFolder(title: string): string {
    const folder = createFolder(this._deps(), this._database(), title, null);
    this.setRootFolderId(folder.id);
    return folder.id;
  }
  setPrivacyMode(enabled: boolean): void { this.set(CONFIG_KEYS.privacyMode, String(enabled)); }
  isPrivacyMode(): boolean { return (this.get(CONFIG_KEYS.privacyMode) ?? 'false') === 'true'; }
  isAutoCreateSubfolders(): boolean { return (this.get(CONFIG_KEYS.autoCreateSubfolders) ?? 'true') === 'true'; }
  getDefaultCategory(): string { return this.get(CONFIG_KEYS.defaultCategory) ?? '通用'; }
  setAutoCreateSubfolders(enabled: boolean): void { this.set(CONFIG_KEYS.autoCreateSubfolders, String(enabled)); }
  setDefaultCategory(category: string): void { this.set(CONFIG_KEYS.defaultCategory, category); }
  setAutoExtractFrequency(frequency: AutoExtractFrequency): void { this.set(CONFIG_KEYS.autoExtractFrequency, frequency); }
  getEvolutionTuning(): EvolutionTuning {
    const parsed = (key: keyof EvolutionTuning, kind: 'i64' | 'u32' | 'usize' | 'f32'): number => {
      const fallback = DEFAULT_EVOLUTION_TUNING[key];
      try {
        const value = this.get(CONFIG_KEYS[key])?.trim();
        if (!value) return fallback;
        if (kind === 'f32') {
          if (/^[+-]?(?:nan|inf|infinity)$/i.test(value)) return f32(Number(value.replace(/inf(?:inity)?/i, 'Infinity')));
          if (/^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)$/.test(value)) {
            return f32(Number(value));
          }
          this._warn(`[Memory::Config] Invalid value '${value}' for ${CONFIG_KEYS[key]}, using default`);
          return fallback;
        }
        if (!/^[+-]?\d+$/.test(value) || (kind !== 'i64' && value.startsWith('-'))) {
          this._warn(`[Memory::Config] Invalid value '${value}' for ${CONFIG_KEYS[key]}, using default`);
          return fallback;
        }
        const n = BigInt(value);
        const min = kind === 'i64' ? -(1n << 63n) : 0n;
        const max = kind === 'i64' ? (1n << 63n) - 1n : kind === 'u32' ? 0xffffffffn : (1n << 64n) - 1n;
        if (n >= min && n <= max) return Number(n);
        this._warn(`[Memory::Config] Invalid value '${value}' for ${CONFIG_KEYS[key]}, using default`);
        return fallback;
      } catch (error) {
        return fallback;
      }
    };
    return {
      stale_hit_days: Math.max(1, parsed('stale_hit_days', 'i64')),
      stale_injected_days: Math.max(1, parsed('stale_injected_days', 'i64')),
      stale_min_hits: parsed('stale_min_hits', 'u32'),
      archive_after_stale_days: Math.max(1, parsed('archive_after_stale_days', 'i64')),
      category_quota: Math.max(1, parsed('category_quota', 'usize')),
      semantic_merge_max_pairs: parsed('semantic_merge_max_pairs', 'usize'),
      semantic_merge_min_score: Math.min(1, Math.max(0, parsed('semantic_merge_min_score', 'f32'))),
      semantic_dedup_interval_minutes: Math.max(30, parsed('semantic_dedup_interval_minutes', 'i64')),
    };
  }
}
