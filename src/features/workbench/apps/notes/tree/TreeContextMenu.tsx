import React, { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import type { NotesWorkspaceTreeMenuItem } from './types';

interface TreeContextMenuProps {
  x: number;
  y: number;
  items: NotesWorkspaceTreeMenuItem[];
  onClose: () => void;
}

export function TreeContextMenu({ x, y, items, onClose }: TreeContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  const onOutsidePointerDown = useCallback((event: Event) => {
    if (menuRef.current?.contains(event.target as Node)) return;
    onClose();
  }, [onClose]);
  const onEscapeKeyDown = useCallback((event: Event) => {
    if (event instanceof KeyboardEvent && event.key === 'Escape') onClose();
  }, [onClose]);
  useEventRegistry([
    { target: 'window', type: 'pointerdown', listener: onOutsidePointerDown, options: true },
    { target: 'window', type: 'keydown', listener: onEscapeKeyDown },
  ], [onEscapeKeyDown, onOutsidePointerDown]);

  useEffect(() => {
    const first = menuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)');
    first?.focus();
  }, [items]);

  const handleMenuKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const isVertical = event.key === 'ArrowDown' || event.key === 'ArrowUp';
    const isEdge = event.key === 'Home' || event.key === 'End';
    if (!isVertical && !isEdge) return;

    const buttons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? [],
    );
    if (!buttons.length) return;
    event.preventDefault();
    event.stopPropagation();

    const currentIndex = buttons.findIndex((button) => button === document.activeElement);
    let nextIndex: number;
    if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = buttons.length - 1;
    else if (currentIndex === -1) nextIndex = event.key === 'ArrowDown' ? 0 : buttons.length - 1;
    else if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % buttons.length;
    else nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;

    buttons[nextIndex]?.focus();
  }, []);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={menuRef}
      className="nwt-context-menu"
      role="menu"
      style={{ left: x, top: y }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={handleMenuKeyDown}
    >
      {items.map((item) => (
        <React.Fragment key={item.id}>
          {item.separatorBefore ? <div role="separator" className="nwt-context-menu-separator" /> : null}
          <button
            type="button"
            role="menuitem"
            className={item.danger ? 'nwt-context-menu-item is-danger' : 'nwt-context-menu-item'}
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              item.onSelect();
              onClose();
            }}
          >
            {item.label}
          </button>
        </React.Fragment>
      ))}
    </div>,
    document.body,
  );
}
