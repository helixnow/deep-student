/**
 * TextContextMenu — native-style right-click menu for text fields and selections.
 *
 * Phase B of native-feel migration (2026-05-14).
 *
 * Strategy: a global window 'contextmenu' listener at the application root
 * intercepts right-clicks. If a descendant component already called
 * `event.preventDefault()` (the common pattern in NotesSidebar / Finder /
 * SessionItem etc.), we honour that and stay out of the way. Otherwise:
 *   - on input / textarea / [contenteditable] OR when the user has selected
 *     text anywhere — we open this menu (Cut / Copy / Paste / Select All / Find)
 *   - on plain chrome — we silently preventDefault so the WebView's
 *     "Reload / Inspect Element" menu never appears in production.
 *
 * Design doc: docs/plans/2026-05-14-native-feel-migration-design.md
 */

import * as React from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Copy, Scissors, ClipboardText, ListChecks } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { useOverlayCoordinator } from '@/components/shared/OverlayCoordinator';
import { copyTextToClipboard, readTextFromClipboard } from '@/utils/clipboardUtils';

// ───────────────────────────────────────────────────────────────────
// Types

export interface TextContextMenuPosition {
  x: number;
  y: number;
  target: HTMLElement;
  hasSelection: boolean;
  isTextField: boolean;
  isReadOnly: boolean;
}

interface TextContextMenuContextValue {
  open: (pos: TextContextMenuPosition) => void;
  close: () => void;
}

const TextContextMenuContext = React.createContext<TextContextMenuContextValue | null>(null);

// ───────────────────────────────────────────────────────────────────
// Helpers

function isEditableTarget(el: HTMLElement | null): el is HTMLElement {
  if (!el) return false;
  if (el instanceof HTMLInputElement) return !el.disabled;
  if (el instanceof HTMLTextAreaElement) return !el.disabled;
  if (el.isContentEditable) return true;
  return false;
}

function isReadOnlyTarget(el: HTMLElement): boolean {
  if (el instanceof HTMLInputElement) return el.readOnly;
  if (el instanceof HTMLTextAreaElement) return el.readOnly;
  return false;
}

async function readClipboardText(): Promise<string | null> {
  return readTextFromClipboard();
}

async function writeClipboardText(text: string): Promise<boolean> {
  try {
    await copyTextToClipboard(text);
    return true;
  } catch {
    return false;
  }
}

function getSelectedText(target: HTMLElement): string {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? 0;
    return target.value.slice(start, end);
  }
  return window.getSelection()?.toString() ?? '';
}

function insertAtSelection(target: HTMLElement, text: string): void {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? target.value.length;
    const before = target.value.slice(0, start);
    const after = target.value.slice(end);
    target.value = before + text + after;
    const cursor = start + text.length;
    target.setSelectionRange(cursor, cursor);
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  if (target.isContentEditable) {
    document.execCommand('insertText', false, text);
  }
}

function deleteSelection(target: HTMLElement): void {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? 0;
    if (start === end) return;
    const before = target.value.slice(0, start);
    const after = target.value.slice(end);
    target.value = before + after;
    target.setSelectionRange(start, start);
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  if (target.isContentEditable) {
    document.execCommand('delete');
  }
}

function selectAll(target: HTMLElement): void {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    target.select();
    return;
  }
  if (target.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(target);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }
}

// ───────────────────────────────────────────────────────────────────
// Menu component

interface TextContextMenuProps {
  position: TextContextMenuPosition;
  onClose: () => void;
}

function TextContextMenu({ position, onClose }: TextContextMenuProps) {
  const { t } = useTranslation('common');
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = React.useState({ top: position.y, left: position.x });
  const [clipboardEmpty, setClipboardEmpty] = React.useState(true);
  const { dismissTooltips, registerInteractiveOverlay } = useOverlayCoordinator();

  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
  const mod = isMac ? '⌘' : 'Ctrl';

  // Probe clipboard availability so the Paste item can be disabled when empty
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const text = await readClipboardText();
      if (!cancelled) setClipboardEmpty(!text);
    })();
    return () => { cancelled = true; };
  }, []);

  React.useEffect(() => {
    dismissTooltips();
    return registerInteractiveOverlay();
  }, [dismissTooltips, registerInteractiveOverlay]);

  // Position with edge clamping after render
  React.useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    let { x, y } = position;
    if (x + rect.width > window.innerWidth - margin) {
      x = Math.max(margin, window.innerWidth - rect.width - margin);
    }
    if (y + rect.height > window.innerHeight - margin) {
      y = Math.max(margin, window.innerHeight - rect.height - margin);
    }
    setCoords({ top: y, left: x });
  }, [position]);

  // Close on outside click / escape
  React.useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const handleScroll = () => onClose();
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKey);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKey);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  // Action handlers
  const refocus = () => {
    if (position.isTextField) {
      try { position.target.focus({ preventScroll: true }); } catch { /* */ }
    }
  };

  const handleCut = async () => {
    const text = getSelectedText(position.target);
    if (text) {
      const ok = await writeClipboardText(text);
      if (ok && !position.isReadOnly && position.isTextField) {
        deleteSelection(position.target);
      }
    }
    refocus();
    onClose();
  };

  const handleCopy = async () => {
    const text = getSelectedText(position.target);
    if (text) await writeClipboardText(text);
    refocus();
    onClose();
  };

  const handlePaste = async () => {
    const text = await readClipboardText();
    if (text && !position.isReadOnly && position.isTextField) {
      insertAtSelection(position.target, text);
    }
    refocus();
    onClose();
  };

  const handleSelectAll = () => {
    selectAll(position.target);
    refocus();
    onClose();
  };

  const hasSelection = position.hasSelection || getSelectedText(position.target).length > 0;
  const canEdit = position.isTextField && !position.isReadOnly;
  const canCut = canEdit && hasSelection;
  const canCopy = hasSelection;
  const canPaste = canEdit && !clipboardEmpty;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className={cn('app-menu-content', 'app-menu-open', 'app-menu-origin-top')}
      style={{
        position: 'fixed',
        top: coords.top,
        left: coords.left,
        minWidth: 200,
      }}
      data-context-menu-handled="true"
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuItem
        icon={<Scissors size={16} />}
        disabled={!canCut}
        onClick={handleCut}
        shortcut={`${mod}+X`}
      >
        {t('contextMenu.cut', '剪切')}
      </MenuItem>
      <MenuItem
        icon={<Copy size={16} />}
        disabled={!canCopy}
        onClick={handleCopy}
        shortcut={`${mod}+C`}
      >
        {t('contextMenu.copy', '复制')}
      </MenuItem>
      <MenuItem
        icon={<ClipboardText size={16} />}
        disabled={!canPaste}
        onClick={handlePaste}
        shortcut={`${mod}+V`}
      >
        {t('contextMenu.paste', '粘贴')}
      </MenuItem>
      <Separator />
      <MenuItem
        icon={<ListChecks size={16} />}
        onClick={handleSelectAll}
        shortcut={`${mod}+A`}
      >
        {t('contextMenu.selectAll', '全选')}
      </MenuItem>
    </div>,
    document.body
  );
}

// Lightweight menu primitives reusing AppMenu.css classes.
function MenuItem({
  icon,
  children,
  shortcut,
  disabled,
  onClick,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
  shortcut?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      className={cn('app-menu-item', disabled && 'app-menu-item-disabled')}
      onClick={(e) => {
        e.preventDefault();
        if (!disabled) onClick();
      }}
    >
      {icon && <span className="app-menu-item-icon">{icon}</span>}
      <span className="app-menu-item-content">{children}</span>
      {shortcut && <span className="app-menu-item-shortcut">{shortcut}</span>}
    </button>
  );
}

function Separator() {
  return <div className="app-menu-separator" role="separator" />;
}

// ───────────────────────────────────────────────────────────────────
// Provider — exposes open/close + wires the global window listener.

export function TextContextMenuProvider({ children }: { children: React.ReactNode }) {
  const [position, setPosition] = React.useState<TextContextMenuPosition | null>(null);

  const open = React.useCallback((pos: TextContextMenuPosition) => setPosition(pos), []);
  const close = React.useCallback(() => setPosition(null), []);
  const value = React.useMemo<TextContextMenuContextValue>(() => ({ open, close }), [open, close]);

  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      // If a descendant already handled it (preventDefault), stay out of the way.
      if (e.defaultPrevented) return;

      const target = e.target as HTMLElement | null;
      if (!target) return;

      const editable = target.closest(
        'input, textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]'
      ) as HTMLElement | null;

      const sel = window.getSelection();
      const hasSelection = !!(sel && sel.toString().length > 0);

      if (editable || hasSelection) {
        e.preventDefault();
        const host = (editable ?? target) as HTMLElement;
        open({
          x: e.clientX,
          y: e.clientY,
          target: host,
          hasSelection,
          isTextField: !!editable && isEditableTarget(editable),
          isReadOnly: editable ? isReadOnlyTarget(editable) : true,
        });
        return;
      }

      // Plain chrome — silently swallow so the WebView default menu never shows.
      e.preventDefault();
    };

    window.addEventListener('contextmenu', handler);
    return () => window.removeEventListener('contextmenu', handler);
  }, [open]);

  return (
    <TextContextMenuContext.Provider value={value}>
      {children}
      {position && <TextContextMenu position={position} onClose={close} />}
    </TextContextMenuContext.Provider>
  );
}

export function useTextContextMenu(): TextContextMenuContextValue {
  const ctx = React.useContext(TextContextMenuContext);
  if (!ctx) {
    // Non-fatal fallback to keep storybook / unit tests working without the provider.
    return {
      open: () => undefined,
      close: () => undefined,
    };
  }
  return ctx;
}
