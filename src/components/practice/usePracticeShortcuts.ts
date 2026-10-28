import { useCallback, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { isComposingKeyEvent } from '@/utils/isComposingKeyEvent';
import { isKeyEventFromOtherModal } from '@/utils/modalKeyGuard';
import { useEventRegistry } from '@/hooks/useEventRegistry';

interface ShortcutActions {
  selectOption?: (key: string) => void;
  selectTrueFalse?: (answer: 'true' | 'false') => void;
  primary?: () => void;
  previous?: () => void;
  next?: () => void;
  favorite?: () => void;
  retry?: () => void;
  toggleTimer?: () => void;
  toggleHidden?: () => void;
}

export interface PracticeShortcutOptions {
  enabled: boolean;
  rootRef: RefObject<HTMLElement>;
  optionKeys?: string[];
  actions: ShortcutActions;
  primaryLabel?: 'editor.shortcutSubmit' | 'batch.shortcutSaveNext' | 'editor.nextQuestion';
}

const COMMANDS = [
  { action: 'primary', key: 'Enter', label: 'editor.shortcutSubmit', display: 'Enter' },
  { action: 'previous', key: 'ArrowLeft', label: 'editor.prevQuestion', display: '←' },
  { action: 'next', key: 'ArrowRight', label: 'editor.nextQuestion', display: '→' },
  { action: 'favorite', key: 'f', label: 'editor.shortcutFavorite', display: 'F' },
  { action: 'retry', key: 'r', label: 'editor.shortcutRetry', display: 'R' },
  { action: 'toggleTimer', key: ' ', label: 'editor.shortcutPauseTimer', display: 'Space' },
  { action: 'toggleHidden', key: 'h', label: 'editor.shortcutHideAnswer', display: 'H' },
] as const;

export function getPracticeShortcutHints({ actions, optionKeys = [], primaryLabel }: Pick<PracticeShortcutOptions, 'actions' | 'optionKeys' | 'primaryLabel'>) {
  const hints: { label: string; keys: string }[] = [];
  if (actions.selectOption && optionKeys.length) {
    const letters = optionKeys.filter(key => /^[a-z]$/i.test(key)).map(key => key.toUpperCase());
    const numbers = optionKeys.length === 1 ? '1' : `1–${Math.min(9, optionKeys.length)}`;
    hints.push({ label: 'editor.shortcutSelectOption', keys: [numbers, letters.join(' / ')].filter(Boolean).join(' / ') });
  }
  if (actions.selectTrueFalse) hints.push({ label: 'editor.shortcutTrueFalse', keys: '1 / 2' });
  for (const command of COMMANDS) {
    if (!actions[command.action]) continue;
    // Option letters own single-letter keys before commands do.
    if (actions.selectOption && optionKeys.some(key => key.toLowerCase() === command.key)) continue;
    hints.push({ label: command.action === 'primary' ? primaryLabel ?? command.label : command.label, keys: command.display });
  }
  return hints;
}

function isVisible(element: Element): boolean {
  if (element.closest('[hidden], [inert], [aria-hidden="true"], [data-state="closed"]')) return false;
  for (let parent: Element | null = element; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
}

/** Scope this additional ownership check to practice; flashcard shortcuts keep their own policy. */
function ownsPracticeEvent(event: Event, root: HTMLElement | null): boolean {
  if (!root || !root.isConnected || !isVisible(root) || isKeyEventFromOtherModal(event, root)) return false;
  const target = event.target instanceof Element ? event.target : null;
  const otherPractice = target?.closest('[data-practice-shortcuts]');
  if (otherPractice && otherPractice !== root) return false;
  for (const popup of document.querySelectorAll('[role="menu"][data-state="open"], [role="listbox"][data-state="open"], [role="dialog"][data-state="open"]:not([aria-modal="true"])')) {
    if (isVisible(popup)) return false;
  }

  // Focus can lag behind an opening portal. Do not rely only on event.target's modal.
  let topModal: Element | null = null;
  let topZ = -Infinity;
  for (const modal of document.querySelectorAll('[aria-modal="true"]')) {
    if (!isVisible(modal)) continue;
    let z = 0;
    for (let parent: Element | null = modal; parent; parent = parent.parentElement) {
      z = Math.max(z, Number.parseInt(getComputedStyle(parent).zIndex, 10) || 0);
    }
    if (z >= topZ) { topModal = modal; topZ = z; }
  }
  return !topModal || topModal.contains(root);
}

function ignoresKey(event: KeyboardEvent | ReactKeyboardEvent): boolean {
  return event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey ||
    (event.shiftKey && !/^[a-z]$/i.test(event.key)) || isComposingKeyEvent(event);
}

function targetOwnsKey(event: KeyboardEvent, root: HTMLElement): boolean {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return false;
  if (target.closest('textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="menu"], [role="listbox"], [role="slider"], [role="spinbutton"]')) return true;
  const control = target.closest('input, button, a[href], [role="button"], [role="radio"], [role="checkbox"]');
  if (!control) return false;
  const scope = root.closest('[aria-modal="true"]') ?? root;
  if (!scope.contains(control)) return true;
  if (control.matches(':disabled, [aria-disabled="true"]')) return true;
  if (control.matches('button, a[href], [role="button"]') && !control.matches('[role="radio"], [role="checkbox"]')) {
    return event.key === 'Enter' || event.key === ' ';
  }
  const choice = control.closest('[data-practice-choice]');
  if (!choice || !root.contains(choice)) return true;
  if (control instanceof HTMLInputElement && !['radio', 'checkbox'].includes(control.type)) return true;
  // Choice radios have no native Enter activation. Real buttons keep Enter/Space.
  return event.key === ' ' || (event.key === 'Enter' && !(control instanceof HTMLInputElement));
}

export function usePracticeShortcuts(options: PracticeShortcutOptions) {
  const latest = useRef(options);
  latest.current = options;

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    const { enabled, rootRef, actions, optionKeys = [] } = latest.current;
    if (!enabled || ignoresKey(event) || !ownsPracticeEvent(event, rootRef.current) || targetOwnsKey(event, rootRef.current!)) return;
    let action: (() => void) | undefined;
    if (actions.selectOption) {
      const option = /^[1-9]$/.test(event.key)
        ? optionKeys[Number(event.key) - 1]
        : /^[a-z]$/i.test(event.key)
          ? optionKeys.find(key => key.toLowerCase() === event.key.toLowerCase())
          : undefined;
      if (option) action = () => actions.selectOption!(option);
    }
    if (!action && actions.selectTrueFalse && (event.key === '1' || event.key === '2')) {
      action = () => actions.selectTrueFalse!(event.key === '1' ? 'true' : 'false');
    }
    if (!action) {
      const command = COMMANDS.find(binding => binding.key === (event.key.length === 1 ? event.key.toLowerCase() : event.key));
      if (command) action = actions[command.action];
    }
    if (!action) return;
    event.preventDefault();
    action();
  }, []);
  useEventRegistry([{ target: 'window', type: 'keydown', listener: handleKeyDown as EventListener }], [handleKeyDown]);

  // Explicit delegation is safer than letting global shortcuts consume text input.
  const onPrimaryAction = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    const { enabled, rootRef, actions } = latest.current;
    if (event.key !== 'Enter' || !enabled || !actions.primary || ignoresKey(event) || event.currentTarget.matches(':disabled') || !ownsPracticeEvent(event.nativeEvent, rootRef.current)) return;
    event.preventDefault();
    actions.primary();
  }, []);

  return onPrimaryAction;
}
