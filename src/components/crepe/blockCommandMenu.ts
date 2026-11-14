import i18next from 'i18next';
import { SlashProvider } from '@milkdown/kit/plugin/slash';
import type { EditorView } from '@milkdown/prose/view';
import type { EditorBlockMenuSurface, EditorBlockMenuRow } from '@/ui-sdk';
import { crepeBlockCommands } from './blockMenuCommands';
import { isBlockTargetCurrent, resolveBlockSelection, type BlockTarget } from './blockTarget';
import { canEditCrepeView, canExecuteCrepeCommand, executeCrepeCommand, LAYOUT_COMMANDS, isLayoutCommand } from './commandRegistry';
import { layoutCommandLabel } from './commandMenus';
import { officialBlockMenuEntries, blockMenuContributions, contractBlockMenuTarget } from './blockMenuContributions';
import { collectEditorBlockMenuRows, mergeEditorEntries } from '@/ui-plugins/official/editor/editorSlots';
import { showGlobalNotification } from '../UnifiedNotification';

const openMenus = new WeakMap<EditorView, () => void>();
const labels: Record<keyof typeof crepeBlockCommands, [string, string]> = {
  paragraph: ['paragraph', '正文'],
  'heading-1': ['heading1', '一级标题'],
  'heading-2': ['heading2', '二级标题'],
  'heading-3': ['heading3', '三级标题'],
  'heading-4': ['heading4', '四级标题'],
  'heading-5': ['heading5', '五级标题'],
  'heading-6': ['heading6', '六级标题'],
  'bullet-list': ['bulletList', '无序列表'],
  'ordered-list': ['orderedList', '有序列表'],
  'task-list': ['taskList', '任务列表'],
  quote: ['quote', '引用'],
  'code-block': ['codeBlock', '代码块'],
  callout: ['callout', '提示块'],
  toggle: ['toggle', '折叠块'],
  duplicate: ['duplicate', '复制块'],
  delete: ['delete', '删除块'],
};

// RUST-FIX(RF-W18-block-menu-contributions): mobile segments merge before render; old entries cannot run after unload.
/** Official segments and community rows share slot ordering; official commands retain their original focus timing. */
function appendContributedRows(
  view: EditorView,
  target: BlockTarget,
  buttons: HTMLButtonElement[],
  menu: HTMLElement,
  close: () => void,
  surface: EditorBlockMenuSurface,
  officialRows: readonly EditorBlockMenuRow[],
): void {
  const host = blockMenuContributions(view);
  const segmentOf = (id: string) => isLayoutCommand(id) ? 'layout' : id === 'duplicate' || id === 'delete' ? 'actions'
    : id in crepeBlockCommands ? 'turn-into' : 'insert';
  const entries = mergeEditorEntries(officialBlockMenuEntries(segment => officialRows.filter(row => segmentOf(row.id) === segment)), host?.entries);
  const onError = host?.onError ?? ((_entry, error) => showGlobalNotification('error', String(error)));
  const rows = collectEditorBlockMenuRows(entries, contractBlockMenuTarget(view, target, surface), host?.editor ?? { options: {} }, onError);
  for (const { entry, row } of rows) {
    const button = document.createElement('button');
    button.type = 'button';
    button.role = 'menuitem';
    button.dataset.command = row.id;
    if (row.destructive) button.dataset.destructive = 'true';
    button.textContent = row.label;
    button.disabled = row.disabled === true;
    button.addEventListener('pointerdown', (event) => event.preventDefault());
    button.addEventListener('click', () => {
      if (row.disabled || !canEditCrepeView(view)) return;
      if (entry.origin !== 'builtin' && !blockMenuContributions(view)?.entries.includes(entry)) return;
      if (entry.origin === 'builtin') { row.run(view); return; }
      close();
      if (!isBlockTargetCurrent(view, target)) return;
      if (!view.isDestroyed) view.focus();
      try {
        const result = row.run(view);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch(error => onError(entry, error));
        }
      } catch (error) {
        onError(entry, error);
      }
    });
    buttons.push(button);
    menu.appendChild(button);
  }
}

/** Programmatic menu using the pinned SlashProvider, without a slash/query in the
 * document. Crepe's built-in items clearTextInCurrentBlock and are unsafe here. */
export function openCrepeBlockCommandMenu(view: EditorView, actions = false): boolean {
  if (!canEditCrepeView(view) || view.composing) return false;
  const target = resolveBlockSelection(view);
  if (!target) return false;
  openMenus.get(view)?.();
  const menu = document.createElement('div');
  menu.className = 'crepe-block-menu';
  menu.role = 'menu';
  menu.setAttribute('aria-label', i18next.t('notes:blockMenu.label', { defaultValue: '块操作' }));
  menu.tabIndex = -1;
  menu.hidden = true;
  const provider = new SlashProvider({
    content: menu, root: document.body, debounce: 0,
    shouldShow: () => isBlockTargetCurrent(view, target) && view.editable,
    floatingUIOptions: { strategy: 'fixed' }, offset: 8,
  });
  let closed = false;
  const close = (refocus = false) => {
    if (closed) return;
    closed = true;
    provider.destroy();
    observer.disconnect();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', keydown, true);
    window.removeEventListener('blur', dismiss);
    view.dom.removeEventListener('compositionstart', dismiss);
    menu.remove();
    openMenus.delete(view);
    if (refocus && !view.isDestroyed) view.focus();
  };
  const dismiss = () => close();
  const outside = (event: Event) => {
    if (!menu.contains(event.target as Node)) close();
  };
  const buttons: HTMLButtonElement[] = [];
  const officialRows: EditorBlockMenuRow[] = [];
  const keydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault();
      event.stopPropagation();
      close(event.key === 'Escape');
      return;
    }
    if (!menu.contains(document.activeElement)) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length
      : event.key === 'ArrowUp' ? (index + buttons.length - 1) % buttons.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    event.stopPropagation();
    buttons[next].focus({ preventScroll: true });
    buttons[next].scrollIntoView?.({ block: 'nearest' });
  };
  // 移动端「块菜单」兼作斜杠菜单：除转换外补齐桌面斜杠菜单的插入项，两端能力一致
  const insertIds = actions ? [] : (['hr', 'math', 'table', 'insert-callout', 'insert-toggle'] as const);
  const insertLabels: Record<(typeof insertIds)[number], [string, string]> = {
    hr: ['notes:slashMenu.textGroup.divider', 'Divider'],
    math: ['notes:slashMenu.advancedGroup.math', 'Math'],
    table: ['notes:slashMenu.advancedGroup.table', 'Table'],
    'insert-callout': ['notes:slashMenu.advancedGroup.callout', 'Callout'],
    'insert-toggle': ['notes:toggle.slashLabel', 'Toggle list'],
  };
  for (const id of insertIds) {
    officialRows.push({ id, label: i18next.t(insertLabels[id][0], { defaultValue: insertLabels[id][1] }),
      disabled: !canExecuteCrepeCommand(view, id), run: () => {
      close();
      void executeCrepeCommand(view, id).catch(error => showGlobalNotification('error', String(error)));
      if (!view.isDestroyed) view.focus();
    } });
  }
  for (const id of [...Object.keys(crepeBlockCommands) as (keyof typeof crepeBlockCommands)[], ...LAYOUT_COMMANDS]) {
    if (!actions && (id === 'duplicate' || id === 'delete')) continue;
    officialRows.push({ id, destructive: id === 'delete', label: isLayoutCommand(id) ? layoutCommandLabel(id)
      : i18next.t(`notes:blockMenu.${labels[id][0]}`, { defaultValue: labels[id][1] }),
      disabled: !canExecuteCrepeCommand(view, id, { target }), run: () => {
      close();
      // The captured target stays bound to its instance/document even after focus changes.
      void executeCrepeCommand(view, id, { target }).catch(error => showGlobalNotification('error', String(error)));
      if (!view.isDestroyed) view.focus();
    } });
  }
  appendContributedRows(view, target, buttons, menu, () => close(), actions ? 'mobile-block' : 'mobile-insert', officialRows);
  // Close on edits, note switches or unmount, including programmatic changes.
  const observer = new MutationObserver(() => {
    if (!view.dom.isConnected || !isBlockTargetCurrent(view, target)) close();
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  provider.onShow = () => {
    menu.hidden = false;
    buttons[0]?.focus({ preventScroll: true });
  };
  provider.onHide = dismiss;
  openMenus.set(view, dismiss);
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', keydown, true);
  window.addEventListener('blur', dismiss);
  view.dom.addEventListener('compositionstart', dismiss);
  provider.update(view);
  return true;
}
