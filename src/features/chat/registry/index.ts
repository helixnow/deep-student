/**
 * Chat V2 - 注册表导出
 */

export { Registry, MODULE_OWNER } from './Registry';
export type { RegistryEntry } from './Registry';
export { modeRegistry, resolveSessionFeatureFlags } from './modeRegistry';
export type {
  ModeConfig,
  ModePlugin,
  SystemPromptContext,
  ModeInitConfig,
  ResolvedSessionFeatureFlags,
} from './modeRegistry';
export { blockRegistry } from './blockRegistry';
export type { BlockComponentProps, OnAbortBehavior, BlockRendererPlugin } from './blockRegistry';
export { eventRegistry } from './eventRegistry';
export type { EventHandler, EventStartPayload } from './eventRegistry';
