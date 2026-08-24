/**
 * 探索器工具栏「更多」折叠菜单。
 *
 * 中窗（medium）侧栏只有 240px，9-10 个图标按钮（约 250px）必然溢出被裁。
 * 折叠形态保留高频入口（后退/前进/新建笔记/新建文件夹），其余动作收进
 * 本菜单；宽窗（wide）不折叠，保持原有一排图标。
 */

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { DotsThree } from '@phosphor-icons/react';
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
}

export const ExplorerOverflowMenu: React.FC<ExplorerOverflowMenuProps> = ({ label, actions }) => {
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
        className={cn('notes-icon-button')}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-active={open ? 'true' : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <DotsThree size={17} weight="bold" />
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
