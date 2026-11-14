/**
 * 插件平台枚举：Host 插件 `meta.platforms`、profile 生成与前端 UI 内核 `meta.platforms` 的单一来源。
 *
 * 本文件不得有任何 import 或 `declare module`：前端（`src/ui-kernel/meta.ts`）直接引用它，
 * 引入 `core.ts` 会把 Host 的 Cordis Context 增强（`ctx.commands` / `ctx.shell` …）带进前端类型。
 */

/** 插件可装配的平台（profile）。 */
export const PLUGIN_PLATFORMS = ['desktop', 'mobile'] as const;

export type PluginPlatform = (typeof PLUGIN_PLATFORMS)[number];
