/**
 * Crepe 编辑器 @ 提及笔记插件
 *
 * 使用（由接线代理注册，本模块不自行挂载）：
 *   import { mentionPlugin } from './mention';
 *   crepe.editor.use(mentionPlugin({ searchNotes }));
 *
 * 详见 docs/revamp/08-mention.md
 */

import type { MilkdownPlugin } from '@milkdown/ctx';

import { createMentionAutocompletePlugin } from './autocomplete';
import type { MentionPluginConfig } from './types';

import './mention.css';

export type {
  MentionNoteCandidate,
  MentionPluginConfig,
  MentionSearchNotes,
} from './types';
export {
  MENTION_EVENTS,
  NOTE_HREF_PROTOCOL,
  dispatchOpenMentionNote,
} from './types';
export { buildNoteHref, parseNoteHref, parseNoteHrefHeading } from './protocol';
export {
  detectMentionTrigger,
  shouldSkipMentionContext,
} from './detectTrigger';
export { applyMentionInsert } from './insertMention';
export { defaultSearchNotes, sliceSuggestions } from './search';
export { handleMentionLinkClick } from './click';
export {
  createMentionAutocompletePlugin,
  mentionAutocompleteKey,
} from './autocomplete';

/**
 * 统一入口：返回可 `editor.use(...)` 的插件。
 * 不自行注册到 Crepe。
 */
export function mentionPlugin(config: MentionPluginConfig = {}): MilkdownPlugin {
  return createMentionAutocompletePlugin(config);
}
