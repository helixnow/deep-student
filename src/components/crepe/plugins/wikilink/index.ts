/**
 * Crepe 编辑器 [[wikilink]] 双链插件（Obsidian 式）
 *
 * 使用（由接线代理注册，本模块不自行挂载）：
 *   import { wikilinkPlugin } from './wikilink';
 *   crepe.editor.use(wikilinkPlugin({ resolve, getNotes }));
 *
 * 详见 docs/revamp/02-wikilink.md
 */

import type { MilkdownPlugin } from '@milkdown/ctx';

import { createWikilinkAutocompletePlugin } from './autocomplete';
import { wikilinkInputRule } from './inputRule';
import { remarkWikilinkPlugin } from './remark';
import { wikilinkSchema } from './schema';
import type { WikilinkPluginConfig } from './types';
import { createWikilinkViewPlugin } from './view';

import './wikilink.css';

export type {
  WikilinkNoteCandidate,
  WikilinkPluginConfig,
  WikilinkResolveResult,
  WikilinkResolver,
} from './types';
export { WIKILINK_EVENTS, normalizeResolve } from './types';
export {
  formatWikiLink,
  parseWikiLinkInner,
  parseWikiLinkText,
  splitWikiLinkTarget,
  findWikiLinksInText,
} from './format';
export { fuzzyMatchNotes } from './fuzzy';
export { detectWikilinkTrigger, buildAutocompleteItems, wikilinkAutocompleteKey } from './autocomplete';
export { wikilinkSchema, WIKILINK_NODE_NAME } from './schema';
export { remarkWikilinkPlugin } from './remark';
export { wikilinkInputRule } from './inputRule';
export { defaultWikilinkGetNotes } from './defaultGetNotes';

/**
 * 统一入口：返回可 `editor.use(...)` 的插件列表（含 schema / remark / inputRule / view / autocomplete）。
 * 不自行注册到 Crepe。
 */
export function wikilinkPlugin(config: WikilinkPluginConfig = {}): MilkdownPlugin[] {
  return [
    remarkWikilinkPlugin,
    wikilinkSchema,
    wikilinkInputRule,
    createWikilinkViewPlugin(config),
    createWikilinkAutocompletePlugin(config),
  ].flat();
}
