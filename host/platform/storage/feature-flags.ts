/**
 * Feature flags and gradual rollout (dstu-storage/src/feature_flags.rs).
 *
 * The wire/serde shape is preserved: `Disabled`/`Enabled` are strings, while
 * `Gradual`/`UserSpecific` are externally tagged objects.  Rollout bucketing
 * reproduces Rust's `DefaultHasher` (SipHash-1-3, keys 0/0) over
 * `user_id.hash(); feature_name.hash()` (`Hash for str` appends 0xFF).
 */
import { chronoSeconds } from './time.ts';

export type FeatureState =
  | 'Disabled'
  | 'Enabled'
  | { Gradual: number }
  | { UserSpecific: string[] };

export const FeatureState = {
  Disabled: 'Disabled' as const,
  Enabled: 'Enabled' as const,
  Gradual: (percentage: number): FeatureState => ({ Gradual: percentage }),
  UserSpecific: (users: string[]): FeatureState => ({ UserSpecific: users }),
};

export interface FeatureFlag {
  name: string;
  description: string;
  state: FeatureState;
  category: string;
  dependencies: string[];
  min_version: string | null;
  max_version: string | null;
  rollout_percentage: number | null;
  created_at: string;
  updated_at: string;
}

function timestamp(): string {
  return chronoSeconds();
}

const U64_MASK = (1n << 64n) - 1n;

function rotl64(value: bigint, bits: bigint): bigint {
  return ((value << bits) | (value >> (64n - bits))) & U64_MASK;
}

function sipRound(v0: bigint, v1: bigint, v2: bigint, v3: bigint): [bigint, bigint, bigint, bigint] {
  v0 = (v0 + v1) & U64_MASK; v1 = rotl64(v1, 13n); v1 ^= v0; v0 = rotl64(v0, 32n);
  v2 = (v2 + v3) & U64_MASK; v3 = rotl64(v3, 16n); v3 ^= v2;
  v0 = (v0 + v3) & U64_MASK; v3 = rotl64(v3, 21n); v3 ^= v0;
  v2 = (v2 + v1) & U64_MASK; v1 = rotl64(v1, 17n); v1 ^= v2; v2 = rotl64(v2, 32n);
  return [v0, v1, v2, v3];
}

/** Rust `std::collections::hash_map::DefaultHasher`（SipHash-1-3，密钥 0,0）。 */
export function sipHash13(bytes: Uint8Array): bigint {
  let v0 = 0x736f6d6570736575n;
  let v1 = 0x646f72616e646f6dn;
  let v2 = 0x6c7967656e657261n;
  let v3 = 0x7465646279746573n;
  const length = bytes.length;
  const full = length - (length % 8);
  for (let offset = 0; offset < full; offset += 8) {
    let word = 0n;
    for (let index = 7; index >= 0; index--) word = (word << 8n) | BigInt(bytes[offset + index]!);
    v3 ^= word;
    [v0, v1, v2, v3] = sipRound(v0, v1, v2, v3);
    v0 ^= word;
  }
  let tail = BigInt(length & 0xff) << 56n;
  for (let index = full; index < length; index++) {
    tail |= BigInt(bytes[index]!) << (8n * BigInt(index - full));
  }
  v3 ^= tail;
  [v0, v1, v2, v3] = sipRound(v0, v1, v2, v3);
  v0 ^= tail;
  v2 ^= 0xffn;
  [v0, v1, v2, v3] = sipRound(v0, v1, v2, v3);
  [v0, v1, v2, v3] = sipRound(v0, v1, v2, v3);
  [v0, v1, v2, v3] = sipRound(v0, v1, v2, v3);
  return (v0 ^ v1 ^ v2 ^ v3) & U64_MASK;
}

/** `hash_user_for_feature`（feature_flags.rs:435）：u64 % 10000 / 10000。 */
export function featureRolloutBucket(userId: string, featureName: string): number {
  const encoder = new TextEncoder();
  const user = encoder.encode(userId);
  const feature = encoder.encode(featureName);
  const bytes = new Uint8Array(user.length + feature.length + 2);
  bytes.set(user, 0);
  bytes[user.length] = 0xff;
  bytes.set(feature, user.length + 1);
  bytes[bytes.length - 1] = 0xff;
  return Number(sipHash13(bytes) % 10000n) / 10000;
}

function clampPercentage(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** feature_flags.rs:35. */
export function newFeatureFlag(name: string, description: string, category: string): FeatureFlag {
  const now = timestamp();
  return {
    name,
    description,
    state: FeatureState.Disabled,
    category,
    dependencies: [],
    min_version: null,
    max_version: null,
    rollout_percentage: null,
    created_at: now,
    updated_at: now,
  };
}

export function enableFlag(flag: FeatureFlag): FeatureFlag {
  flag.state = FeatureState.Enabled;
  flag.updated_at = timestamp();
  return flag;
}

export function disableFlag(flag: FeatureFlag): FeatureFlag {
  flag.state = FeatureState.Disabled;
  flag.updated_at = timestamp();
  return flag;
}

export function setGradual(flag: FeatureFlag, percentage: number): FeatureFlag {
  flag.state = FeatureState.Gradual(clampPercentage(percentage));
  flag.rollout_percentage = percentage;
  flag.updated_at = timestamp();
  return flag;
}

export function setUserSpecific(flag: FeatureFlag, users: string[]): FeatureFlag {
  flag.state = FeatureState.UserSpecific(users);
  flag.updated_at = timestamp();
  return flag;
}

export function withDependencies(flag: FeatureFlag, dependencies: string[]): FeatureFlag {
  flag.dependencies = dependencies;
  return flag;
}

export function withVersionRange(flag: FeatureFlag, min: string | null, max: string | null): FeatureFlag {
  flag.min_version = min;
  flag.max_version = max;
  return flag;
}

/** FeatureFlagManager needs only these two settings operations (database/mod.rs). */
export interface FeatureFlagSettingsStore {
  getSetting(key: string): string | null;
  saveSetting(key: string, value: string): void;
}

export class FeatureFlagManager {
  flags = new Map<string, FeatureFlag>();
  user_id: string | null = null;
  app_version: string;
  debug: boolean;

  constructor(appVersion: string, debug = false) {
    this.app_version = appVersion;
    this.debug = debug;
  }

  withUserId(userId: string): this {
    this.user_id = userId;
    return this;
  }

  /** feature_flags.rs:115. */
  loadFromDatabase(db: FeatureFlagSettingsStore): this {
    let flagsJson: string | null;
    try { flagsJson = db.getSetting('feature_flags.config'); }
    catch (error) { throw new Error(`Failed to load feature flags: ${error instanceof Error ? error.message : String(error)}`); }
    if (flagsJson !== null) {
      let parsed: Record<string, FeatureFlag>;
      try { parsed = JSON.parse(flagsJson) as Record<string, FeatureFlag>; }
      catch (error) { throw new Error(`Failed to parse feature flags: ${error instanceof Error ? error.message : String(error)}`); }
      this.flags = new Map(Object.entries(parsed));
      this.mergeMissingDefaultFlags();
    } else {
      this.initializeDefaultFlags();
    }
    return this;
  }

  /** feature_flags.rs:147. */
  saveToDatabase(db: FeatureFlagSettingsStore): void {
    let json: string;
    try { json = JSON.stringify(Object.fromEntries(this.flags)); }
    catch (error) { throw new Error(`Failed to serialize feature flags: ${error instanceof Error ? error.message : String(error)}`); }
    try { db.saveSetting('feature_flags.config', json); }
    catch (error) { throw new Error(`Failed to save feature flags: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /** feature_flags.rs:135. */
  mergeMissingDefaultFlags(): void {
    const defaults = new FeatureFlagManager(this.app_version, this.debug);
    if (this.user_id !== null) defaults.user_id = this.user_id;
    defaults.initializeDefaultFlags();
    for (const [name, flag] of defaults.flags) {
      if (!this.flags.has(name)) this.flags.set(name, flag);
    }
  }

  /** feature_flags.rs:156. */
  isFeatureEnabled(featureName: string): boolean {
    const flag = this.flags.get(featureName);
    if (!flag) return false;
    if (!this.isVersionCompatible(flag)) return false;
    if (!this.areDependenciesSatisfied(flag)) return false;

    if (flag.state === 'Disabled') return false;
    if (flag.state === 'Enabled') return true;
    if ('Gradual' in flag.state) {
      if (this.user_id !== null) return this.hashUserForFeature(this.user_id, featureName) < flag.state.Gradual;
      return Math.random() < flag.state.Gradual;
    }
    if (this.user_id !== null) return flag.state.UserSpecific.includes(this.user_id);
    return false;
  }

  getFeatureFlag(featureName: string): FeatureFlag | undefined {
    return this.flags.get(featureName);
  }

  listAllFlags(): FeatureFlag[] {
    return [...this.flags.values()];
  }

  getFlagsByCategory(category: string): FeatureFlag[] {
    return [...this.flags.values()].filter((flag) => flag.category === category);
  }

  updateFlag(featureName: string, newFlag: FeatureFlag): void {
    this.flags.set(featureName, newFlag);
  }

  enableFeature(featureName: string): void {
    const flag = this.flags.get(featureName);
    if (!flag) throw new Error(`Feature '${featureName}' not found`);
    flag.state = FeatureState.Enabled;
    flag.updated_at = timestamp();
  }

  disableFeature(featureName: string): void {
    const flag = this.flags.get(featureName);
    if (!flag) throw new Error(`Feature '${featureName}' not found`);
    flag.state = FeatureState.Disabled;
    flag.updated_at = timestamp();
  }

  setGradualRollout(featureName: string, percentage: number): void {
    const flag = this.flags.get(featureName);
    if (!flag) throw new Error(`Feature '${featureName}' not found`);
    const clamped = clampPercentage(percentage);
    flag.state = FeatureState.Gradual(clamped);
    flag.rollout_percentage = clamped;
    flag.updated_at = timestamp();
  }

  /** feature_flags.rs:262. */
  initializeDefaultFlags(): void {
    const add = (flag: FeatureFlag) => this.flags.set(flag.name, flag);
    add(enableFlag(newFeatureFlag('security.keychain_storage', 'Keychain安全存储功能', 'security')));
    add(withDependencies(
      enableFlag(newFeatureFlag('security.auto_migration', '启动时自动迁移敏感数据', 'security')),
      ['security.keychain_storage'],
    ));
    add(disableFlag(newFeatureFlag('search.reranker', '搜索结果重排序功能', 'search')));
    add(enableFlag(newFeatureFlag('search.cn_whitelist', '中文可信站点白名单', 'search')));
    add(enableFlag(newFeatureFlag('search.provider_strategies', 'Provider策略矩阵', 'search')));
    add(enableFlag(newFeatureFlag('tools.namespace_conflict_detection', '工具名冲突检测', 'tools')));
    add(enableFlag(newFeatureFlag('tools.error_details', '详细错误信息', 'tools')));
    add(enableFlag(newFeatureFlag('observability.trace_id', 'TraceID贯通', 'observability')));
    add(setGradual(newFeatureFlag('observability.performance_metrics', '性能指标收集', 'observability'), 0.3));
    add(disableFlag(newFeatureFlag('ui.engine_status_panel', '引擎状态面板', 'ui')));
    add(disableFlag(newFeatureFlag('ui.mcp_tool_hover', 'MCP工具悬停摘要', 'ui')));
    add(disableFlag(newFeatureFlag('ui.error_dialog_actions', '错误对话框快捷操作', 'ui')));
    add(enableFlag(newFeatureFlag('anki.pipeline_v2', '制卡流水线真源/恢复修复', 'anki')));
    add(withDependencies(
      enableFlag(newFeatureFlag('anki.flashcard_app', '闪卡子应用', 'anki')),
      ['anki.pipeline_v2'],
    ));
    add(disableFlag(newFeatureFlag('anki.fsrs_export_scheduling', 'FSRS 导出调度', 'anki')));
    add(this.debug
      ? enableFlag(newFeatureFlag('ui.workbench_browser', '学习桌面内置浏览器', 'ui'))
      : disableFlag(newFeatureFlag('ui.workbench_browser', '学习桌面内置浏览器', 'ui')));
    add(withDependencies(
      disableFlag(newFeatureFlag('tools.browser_agent', 'ChatV2 Agent 操控内置浏览器', 'tools')),
      ['ui.workbench_browser'],
    ));
    add(enableFlag(newFeatureFlag('tools.workbench_agent', 'ChatV2 Agent 操控学习桌面', 'tools')));
  }

  /** feature_flags.rs:397. */
  static compareVersions(a: string, b: string): number {
    const parse = (value: string): bigint[] => value.split('.').map((part) => {
      if (!/^\+?[0-9]+$/.test(part)) return 0n;
      const parsed = BigInt(part);
      return parsed > U64_MASK ? 0n : parsed;
    });
    const left = parse(a);
    const right = parse(b);
    const length = Math.min(left.length, right.length);
    for (let index = 0; index < length; index++) {
      const l = left[index]!;
      const r = right[index]!;
      if (l < r) return -1;
      if (l > r) return 1;
    }
    return Math.sign(left.length - right.length);
  }

  /** feature_flags.rs:407. */
  private isVersionCompatible(flag: FeatureFlag): boolean {
    if (flag.min_version !== null && FeatureFlagManager.compareVersions(this.app_version, flag.min_version) < 0) return false;
    if (flag.max_version !== null && FeatureFlagManager.compareVersions(this.app_version, flag.max_version) > 0) return false;
    return true;
  }

  /** feature_flags.rs:425. */
  private areDependenciesSatisfied(flag: FeatureFlag): boolean {
    return flag.dependencies.every((dependency) => this.isFeatureEnabled(dependency));
  }

  /** feature_flags.rs:435. */
  private hashUserForFeature(userId: string, featureName: string): number {
    return featureRolloutBucket(userId, featureName);
  }
}
