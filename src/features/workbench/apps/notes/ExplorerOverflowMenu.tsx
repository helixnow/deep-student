/**
 * 文件侧栏的新建 / 更多菜单。所有窗口尺寸使用一致的文字入口。
 */

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { DotsThree, Plus, CaretDown } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';

export interface ExplorerOverflowAction {
  key: string;
  label: string;
  icon: React.ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  /** 双态动作（如背链面板开关）的当前状态 */
  active?: boolean;
}

export interface ExplorerOverflowMenuProps {
  label: string;
  actions: readonly ExplorerOverflowAction[];
  triggerText?: string;
}

export const ExplorerOverflowMenu: React.FC<ExplorerOverflowMenuProps> = ({ label, actions, triggerText }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const close = useCallback((options: { restoreFocus?: boolean } = {}) => {
    setOpen(false);
    if (options.restoreFocus) triggerRef.current?.focus();
  }, []);

  // 点击菜单外任意位置关闭
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  // 打开后聚焦第一项，支持上下键循环
  useEffect(() => {
    if (!open) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    first?.focus();
  }, [open]);

  const onMenuKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close({ restoreFocus: true });
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
    );
    if (items.length === 0) return;
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    const nextIndex = currentIndex < 0
      ? (direction === 1 ? 0 : items.length - 1)
      : (currentIndex + direction + items.length) % items.length;
    items[nextIndex]?.focus();
  }, [close]);

  return (
    <div ref={rootRef} className="notes-explorer-overflow" data-notes-explorer-overflow>
      <button
        ref={triggerRef}
        type="button"
        className={cn('notes-icon-button', triggerText && 'notes-explorer-create-trigger')}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-active={open ? 'true' : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        {triggerText ? <><Plus size={14} aria-hidden /><span>{triggerText}</span><CaretDown size={10} aria-hidden /></> : <DotsThree size={17} weight="bold" />}
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          className="notes-explorer-overflow-menu ui-rise-in"
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKeyDown}
        >
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              role={action.active === undefined ? 'menuitem' : 'menuitemcheckbox'}
              aria-checked={action.active === undefined ? undefined : action.active}
              disabled={action.disabled}
              onClick={() => {
                close({ restoreFocus: true });
                action.onSelect();
              }}
            >
              <span className="notes-explorer-overflow-icon" aria-hidden="true">{action.icon}</span>
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default ExplorerOverflowMenu;
