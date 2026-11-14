// src/cmd/web_search.rs get_feature_flags / update_feature_flag shaping over the F3 `ctx.featureFlags` manager.
import type { FeatureFlagsService } from '../../../platform/storage/api.ts';

type FeatureFlag = ReturnType<FeatureFlagsService['newFlag']>;

export interface FeatureFlagsCommandResult {
  flags: FeatureFlag[];
  flags_by_category: Record<string, FeatureFlag[]>;
  total_count: number;
}
export interface FeatureFlagsSource { listAllFlags(): FeatureFlag[] }
export function featureFlagsResult(manager: FeatureFlagsSource): FeatureFlagsCommandResult {
  const flags = manager.listAllFlags();
  const byCategory: Record<string, FeatureFlag[]> = {};
  for (const flag of flags) (byCategory[flag.category] ??= []).push(flag);
  return { flags, flags_by_category: byCategory, total_count: flags.length };
}

/**
 * `v.as_f64() as f32` (cmd/web_search.rs set_gradual). Returns the shortest decimal that
 * round-trips the f32, which is what serde_json writes for an f32 and reads back later.
 */
export function rustF64AsF32(value: number): number {
  const single = Math.fround(value);
  if (!Number.isFinite(single) || single === 0) return single;
  for (let digits = 1; digits <= 9; digits += 1) {
    const candidate = Number(single.toPrecision(digits));
    if (Math.fround(candidate) === single) return candidate;
  }
  return single;
}
