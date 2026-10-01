import type { Ctx } from '@milkdown/ctx';
import { editorViewCtx } from '@milkdown/kit/core';
import i18next from 'i18next';
import { executeCrepeCommand, LAYOUT_COMMANDS, type CrepeCommandId } from './commandRegistry';
import { CALLOUT_SLASH_ICON } from './plugins/slashMenuExtras';
import { showGlobalNotification } from '../UnifiedNotification';

export const layoutCommandLabel = (id: string) => i18next.t(`notes:layout.${id}`, {
  defaultValue: ({ 'insert-columns': '插入双列', 'insert-cornell': '插入康奈尔布局',
    'convert-columns': '转为双列', 'convert-cornell': '转为康奈尔布局',
    'convert-cornell-template': '转换康奈尔模板', 'unwrap-columns': '展开为普通块' } as Record<string, string>)[id] ?? id,
});
type Item = { key: string; onRun?: (ctx: Ctx) => void };
interface CommandMenuBuilder {
  build(): { key: string; items: Item[] }[];
  addGroup(key: string, label: string): { addItem(key: string, item: {
    label: string; icon: string; active: (ctx: Ctx) => boolean; onRun: (ctx: Ctx) => void;
  }): unknown };
}
const slashCommands: Record<string, CrepeCommandId> = { text: 'paragraph', h1: 'heading-1', h2: 'heading-2', h3: 'heading-3',
  h4: 'heading-4', h5: 'heading-5', h6: 'heading-6', quote: 'quote', divider: 'hr',
  'bullet-list': 'bullet-list', 'ordered-list': 'ordered-list', 'task-list': 'task-list',
  image: 'image', code: 'code-block', table: 'table', math: 'math', callout: 'insert-callout', toggle: 'insert-toggle' };
const bubbleCommands: Record<string, CrepeCommandId> = { bold: 'bold', italic: 'italic', strikethrough: 'strikethrough',
  code: 'inline-code', link: 'link', latex: 'inline-math' };

/** Preserve Milkdown's labels/icons/keymaps; replace every document-writing onRun
 * with the same registry used by the desktop and mobile formatting controls. */
export function wireCrepeCommandMenu(builder: CommandMenuBuilder, kind: 'slash' | 'bubble'): void {
  const invoke = (id: CrepeCommandId) => (ctx: Ctx) => {
    void executeCrepeCommand(ctx.get(editorViewCtx), id, { slash: kind === 'slash' })
      .catch(error => showGlobalNotification('error', String(error)));
  };
  for (const group of builder.build()) for (const item of group.items) {
    const id = (kind === 'slash' ? slashCommands : bubbleCommands)[item.key];
    if (id) item.onRun = invoke(id);
  }
  // The selection bubble edits inline text. Page layout belongs in the labelled
  // formatting/slash/block menus, not six indistinguishable bubble buttons.
  if (kind === 'bubble') return;
  const layouts = builder.addGroup('note-layout', i18next.t('notes:layout.label', { defaultValue: '页面布局' }));
  for (const id of LAYOUT_COMMANDS) layouts.addItem(id, {
    label: layoutCommandLabel(id), icon: CALLOUT_SLASH_ICON, active: () => false, onRun: invoke(id),
  });
}
