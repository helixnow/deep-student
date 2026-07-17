import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { NotesWorkspaceTreeMenuItem } from './types';

interface TreeContextMenuProps {
  x: number;
  y: number;
  items: NotesWorkspaceTreeMenuItem[];
  onClose: () => void;
}

export function TreeContextMenu({ x, y, items, onClose }: TreeContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    const first = menuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)');
    first?.focus();
  }, [items]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={menuRef}
      className="nwt-context-menu"
      role="menu"
      style={{ left: x, top: y }}
      onPointerDown={(event) => event.stopPropagation()}
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
