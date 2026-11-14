import type { Ctx } from '@milkdown/ctx';
import { editorViewCtx } from '@milkdown/kit/core';
import i18next from 'i18next';
import type { SlotEntry } from '@/ui-kernel/slots';
import { editorContributions, type EditorSelectionToolbarContribution, type EditorSlashMenuContribution } from '@/ui-plugins/official/editor/editorSlots';
import { executeCrepeCommand, isLayoutCommand, LAYOUT_COMMANDS, type CrepeCommandId } from './commandRegistry';
import { appendCalloutToggleSlashItems, CALLOUT_SLASH_ICON } from './plugins/slashMenuExtras';
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
export interface BubbleHostAction {
  key: string;
  label: string;
  icon: string;
  run: (selectedText: string) => void;
}

type ToolbarGroupBuilder = {
  addGroup(key: string, label: string): { addItem(key: string, item: { label: string; icon: string; active?: (ctx: Ctx) => boolean; onRun?: (ctx: Ctx) => void }): unknown };
};

/**
 * The host actions group of the bubble toolbar (「更多」), read when the editor creates its toolbar. Actions added to
 * `selectionActions` after creation do not appear on that instance.
 */
export function appendBubbleHostActions(builder: ToolbarGroupBuilder, getHostActions: () => BubbleHostAction[]): void {
  const actions = getHostActions();
  if (actions.length === 0) return;
  const host = builder.addGroup('host-actions', i18next.t('notes:selection.group', { defaultValue: '更多' }));
  for (const action of actions) host.addItem(action.key, {
    label: action.label,
    icon: action.icon,
    active: () => false,
    onRun: (ctx) => {
      const view = ctx.get(editorViewCtx);
      const { from, to } = view.state.selection;
      const text = view.state.doc.textBetween(from, to, '\n', '\n').trim();
      // 浮条只在初始化时构建一次：执行时按 key 取宿主最新的回调，避免闭包过期
      const current = getHostActions().find(a => a.key === action.key) ?? action;
      if (text) current.run(text);
    },
  });
}

export function wireCrepeCommandMenu(
  builder: CommandMenuBuilder,
  kind: 'slash' | 'bubble',
  getHostActions?: () => BubbleHostAction[],
): void {
  const invoke = (id: CrepeCommandId) => (ctx: Ctx) => {
    void executeCrepeCommand(ctx.get(editorViewCtx), id, { slash: kind === 'slash' })
      .then((applied) => {
        // 菜单项对当前位置不适用（如在分栏外「展开为普通块」）：明确告知，而不是静默无事发生
        if (applied === false && isLayoutCommand(id)) {
          showGlobalNotification('info', i18next.t('notes:layout.unavailable_here', { defaultValue: '当前位置不可用：{{label}}', label: layoutCommandLabel(id) }));
        }
      })
      .catch(error => showGlobalNotification('error', String(error)));
  };
  for (const group of builder.build()) for (const item of group.items) {
    const id = (kind === 'slash' ? slashCommands : bubbleCommands)[item.key];
    if (id) item.onRun = invoke(id);
  }
  // The selection bubble edits inline text. Page layout belongs in the labelled
  // formatting/slash/block menus, not six indistinguishable bubble buttons.
  if (kind === 'bubble') {
    appendBubbleHostActions(builder, getHostActions ?? (() => []));
    return;
  }
  const layouts = builder.addGroup('note-layout', i18next.t('notes:layout.label', { defaultValue: '页面布局' }));
  for (const id of LAYOUT_COMMANDS) layouts.addItem(id, {
    label: layoutCommandLabel(id), icon: CALLOUT_SLASH_ICON, active: () => false, onRun: invoke(id),
  });
}

function officialSlashEntry(id: string, order: number, build: EditorSlashMenuContribution['build']): SlotEntry<EditorSlashMenuContribution> {
  return { id, order, owner: 'dstu.ui.editor', origin: 'builtin', value: { build } };
}

/**
 * 官方斜杠菜单（`editor.slashMenu`）：callout / toggle 追加到 advanced 分组，然后把全部写文档的条目接到编辑器命令表，
 * 并追加页面布局分组。顺序不能颠倒：后者要改写前者加入的条目。
 */
export const officialSlashMenuEntries: readonly SlotEntry<EditorSlashMenuContribution>[] = [
  officialSlashEntry('slash:callout-toggle', 10, (menu) => appendCalloutToggleSlashItems(menu)),
  officialSlashEntry('slash:editor-commands', 20, (menu) => wireCrepeCommandMenu(menu, 'slash')),
];

for (const entry of officialSlashMenuEntries) editorContributions.announce({ slot: 'editor.slashMenu', entry });

function officialToolbarEntry(
  id: string,
  order: number,
  build: EditorSelectionToolbarContribution['build'],
): SlotEntry<EditorSelectionToolbarContribution> {
  return { id, order, owner: 'dstu.ui.editor', origin: 'builtin', value: { build } };
}

/**
 * 官方选中浮条（`editor.selectionToolbar`）：把 Crepe 内置按钮接到编辑器命令表（10），再追加宿主选区动作分组
 * （20）。宿主动作是编辑器实例状态（`selectionActionsRef`），所以条目按实例构建；`order` 与其他条目合并排序后，
 * 社区条目可落在两者之间。
 */
// RUST-FIX(RF-W18-selection-toolbar-contributions): host callbacks remain per-instance.
export function officialSelectionToolbarEntries(
  getHostActions: () => BubbleHostAction[],
): SlotEntry<EditorSelectionToolbarContribution>[] {
  return [
    officialToolbarEntry('toolbar:editor-commands', 10, (toolbar) => wireCrepeCommandMenu(toolbar, 'bubble')),
    officialToolbarEntry('toolbar:host-actions', 20, (toolbar) => appendBubbleHostActions(toolbar, getHostActions)),
  ];
}
