/**
 * 插件平台声明（W14）：`meta.platforms` 声明插件能装配到哪些平台的 profile。
 *
 * - 缺省视为 `['desktop']`：现有插件不用改就保持原样进入 `desktop.json`，也不会被误装进移动端；
 * - 可移植插件（只经平台服务访问文件/网络/加密，不 import Node 专有模块）声明 `['desktop', 'mobile']`；
 * - 只能在移动端运行的平台实现（如 `host/platform/crypto/mobile.ts`）声明 `['mobile']`。
 *
 * 字段与平台枚举定义在 kernel 插件类型（`host/kernel/core.ts` 的 `PluginMeta.platforms` / `PLUGIN_PLATFORMS`），
 * 本文件负责缺省值与校验。
 */
import { PLUGIN_PLATFORMS, type PluginMeta, type PluginPlatform } from '../kernel/core.ts';

export { PLUGIN_PLATFORMS };
export type { PluginPlatform };

/** 缺省平台：未声明 `meta.platforms` 的插件只进桌面 profile。 */
export const DEFAULT_PLUGIN_PLATFORMS: readonly PluginPlatform[] = ['desktop'];

/** 读取并校验 `meta.platforms`：缺省返回 `['desktop']`；空数组、未知平台或重复项抛错（生成 profile 时尽早失败）。 */
export function pluginPlatforms(meta: Pick<PluginMeta, 'id' | 'platforms'>): readonly PluginPlatform[] {
  const declared = meta.platforms;
  if (declared === undefined) return DEFAULT_PLUGIN_PLATFORMS;
  if (!Array.isArray(declared) || declared.length === 0) throw new Error(`${meta.id}: meta.platforms must be a non-empty array`);
  const seen = new Set<string>();
  for (const platform of declared as readonly unknown[]) {
    if (typeof platform !== 'string' || !(PLUGIN_PLATFORMS as readonly string[]).includes(platform)) {
      throw new Error(`${meta.id}: unknown platform ${JSON.stringify(platform)} in meta.platforms (expected ${PLUGIN_PLATFORMS.join(' | ')})`);
    }
    if (seen.has(platform)) throw new Error(`${meta.id}: duplicate platform ${platform} in meta.platforms`);
    seen.add(platform);
  }
  return declared;
}

export function supportsPlatform(meta: Pick<PluginMeta, 'id' | 'platforms'>, platform: PluginPlatform): boolean {
  return pluginPlatforms(meta).includes(platform);
}
