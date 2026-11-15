// Shared feature flag commands over the F3 `ctx.featureFlags` manager.
import { CommandError } from '../../kernel/api.ts';
import { AppError } from '../errors/api.ts';
import type { FeatureFlagsService } from '../storage/api.ts';
import type { SettingsStore } from './api.ts';

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

type FeatureFlagUpdate = { featureName: string; action: string; value?: unknown };

export function createFeatureFlagCommands(options: {
  featureFlags: Pick<FeatureFlagsService, 'load' | 'save'>;
  settings: Pick<SettingsStore, 'get' | 'save'>;
  appVersion: string;
  debug: boolean;
}) {
  const { featureFlags, settings, appVersion, debug } = options;
  const store = {
    getSetting: (key: string) => settings.get(key),
    saveSetting: (key: string, value: string) => { settings.save(key, value); },
  };
  const fail = (prefix: string, error: unknown) => new CommandError(
    AppError.from(`${prefix}: ${error instanceof Error ? error.message : String(error)}`),
  );
  const load = (userId: string | null = null) => {
    try { return featureFlags.load(store, appVersion, { debug, userId }); }
    catch (error) { throw fail('加载功能开关失败', error); }
  };
  return {
    getFeatureFlags: () => featureFlagsResult(load()),
    updateFeatureFlag: ({ featureName, action, value }: FeatureFlagUpdate) => {
      const manager = load();
      let actionText: string;
      switch (action) {
        case 'enable':
          try { manager.enableFeature(featureName); }
          catch (error) { throw fail('启用功能失败', error); }
          actionText = '启用';
          break;
        case 'disable':
          try { manager.disableFeature(featureName); }
          catch (error) { throw fail('禁用功能失败', error); }
          actionText = '禁用';
          break;
        case 'set_gradual':
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw new CommandError(AppError.from('渐进发布需要提供百分比参数'));
          }
          try { manager.setGradualRollout(featureName, rustF64AsF32(value)); }
          catch (error) { throw fail('设置渐进发布失败', error); }
          actionText = '设置渐进发布';
          break;
        case 'reset': {
          const defaults = featureFlags.load({ ...store, getSetting: () => null }, appVersion, { debug });
          const flag = defaults.getFeatureFlag(featureName);
          if (!flag) throw new CommandError(AppError.from(`没有可重置的功能开关: ${featureName}`));
          manager.updateFlag(featureName, flag);
          actionText = '重置';
          break;
        }
        default:
          throw new CommandError(AppError.from(`不支持的操作: ${action}`));
      }
      try { featureFlags.save(manager, store); }
      catch (error) { throw fail('保存功能开关失败', error); }
      return { success: true, message: `功能 '${featureName}' 已成功${actionText}` };
    },
    isFeatureEnabled: ({ featureName, userId }: { featureName: string; userId?: string | null }) =>
      load(userId ?? null).isFeatureEnabled(featureName),
  };
}
