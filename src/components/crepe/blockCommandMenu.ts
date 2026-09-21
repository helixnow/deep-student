import i18next from 'i18next';
import { SlashProvider } from '@milkdown/kit/plugin/slash';
import type { EditorView } from '@milkdown/prose/view';
import { crepeBlockCommands } from './blockMenuCommands';
import { isBlockTargetCurrent, resolveBlockSelection } from './blockTarget';

const openMenus = new WeakMap<EditorView, () => void>();
const labels: Record<keyof typeof crepeBlockCommands, [string, string]> = {
  paragraph: ['paragraph', '正文'],
  'heading-1': ['heading1', '一级标题'],
  'heading-2': ['heading2', '二级标题'],
  'heading-3': ['heading3', '三级标题'],
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

/** Programmatic menu using the pinned SlashProvider, without a slash/query in the
 * document. Crepe's built-in items clearTextInCurrentBlock and are unsafe here. */
export function openCrepeBlockCommandMenu(view: EditorView, actions = false): boolean {
  if (view.isDestroyed || !view.editable || view.composing) return false;
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
  for (const id of Object.keys(crepeBlockCommands) as (keyof typeof crepeBlockCommands)[]) {
    if (!actions && (id === 'duplicate' || id === 'delete')) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.role = 'menuitem';
    button.dataset.command = id;
    if (id === 'delete') button.dataset.destructive = 'true';
    button.textContent = i18next.t(`notes:blockMenu.${labels[id][0]}`, { defaultValue: labels[id][1] });
    button.addEventListener('pointerdown', (event) => event.preventDefault());
    button.addEventListener('click', () => {
      close();
      // The captured target stays bound to its instance/document even after focus changes.
      crepeBlockCommands[id](view, target);
      if (!view.isDestroyed) view.focus();
    });
    buttons.push(button);
    menu.appendChild(button);
  }
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
