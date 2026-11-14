/**
 * 桌面玻璃菜单（wb-desk-menu）的行：桌面右键菜单、菜单栏菜单与桌面图标菜单共用。
 * `DeskMenuRow` 渲染一行 `app.menu`（子菜单父项由桌面右键菜单自己渲染）。
 */
import React from 'react';
import { CaretRight, Check } from '@phosphor-icons/react';
import type { ResolvedAppMenuRow } from '@/ui-plugins/official/menu/appMenu';
import './DesktopContextMenu.css';

interface ActionItemProps {
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  /** 危险操作（删除/移除等）：红字 + 红色 hover 高亮 */
  danger?: boolean;
  /** 有值 = 子菜单父项（渲染 caret + aria-haspopup） */
  subId?: string;
  subOpen?: boolean;
  /** checkbox 菜单项语义 */
  checked?: boolean;
  /** 右缘快捷键提示（仅展示，不参与交互） */
  shortcut?: string;
  /** 测试/自动化定位（不参与展示） */
  testId?: string;
  onClick?: () => void;
  onPointerEnter?: () => void;
}

/** 桌面玻璃菜单动作行（StatusBarBrandMenu 同款复用） */
export const ActionItem: React.FC<ActionItemProps> = ({
  icon,
  label,
  disabled,
  danger,
  subId,
  subOpen,
  checked,
  shortcut,
  testId,
  onClick,
  onPointerEnter,
}) => (
  <button
    type="button"
    className={danger ? 'wb-desk-menu-item wb-desk-menu-item--danger' : 'wb-desk-menu-item'}
    data-wb-desk-item=""
    data-wb-desk-sub={subId}
    data-wb-desk-active={subOpen ? 'true' : undefined}
    data-testid={testId}
    role={checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
    aria-checked={checked !== undefined ? checked : undefined}
    aria-haspopup={subId ? 'menu' : undefined}
    aria-expanded={subId ? Boolean(subOpen) : undefined}
    disabled={disabled}
    onClick={onClick}
    onPointerEnter={onPointerEnter}
  >
    <span className="wb-desk-menu-item-icon" aria-hidden="true">
      {icon}
    </span>
    <span className="wb-desk-menu-item-label">{label}</span>
    {shortcut && !subId && (
      <span className="wb-desk-menu-item-shortcut" aria-hidden="true">
        {shortcut}
      </span>
    )}
    {checked !== undefined && (
      <span className="wb-desk-menu-item-check" aria-hidden="true">
        {checked ? <Check size={13} weight="bold" /> : null}
      </span>
    )}
    {subId && (
      <span className="wb-desk-menu-item-caret" aria-hidden="true">
        <CaretRight size={12} weight="bold" />
      </span>
    )}
  </button>
);

interface RadioItemProps {
  label: string;
  /** 稳定选择值（测试/自动化定位用，不参与展示） */
  value: string;
  checked: boolean;
  disabled?: boolean;
  testId?: string;
  onSelect?: () => void;
  onPointerEnter?: () => void;
}

export const RadioItem: React.FC<RadioItemProps> = ({ label, value, checked, disabled, testId, onSelect, onPointerEnter }) => (
  <button
    type="button"
    className="wb-desk-menu-item"
    data-wb-desk-item=""
    data-wb-desk-option={value}
    data-testid={testId}
    role="menuitemradio"
    aria-checked={checked}
    disabled={disabled}
    onClick={onSelect}
    onPointerEnter={onPointerEnter}
  >
    <span className="wb-desk-menu-item-icon" aria-hidden="true">
      {checked ? <Check size={13} weight="bold" /> : null}
    </span>
    <span className="wb-desk-menu-item-label">{label}</span>
  </button>
);

/** 一行 `app.menu`：分隔线、单选项或动作行；执行后 `onDone` 关闭菜单（`closeOnRun: false` 的行自己关） */
export function DeskMenuRow({ row, onDone, onPointerEnter }: {
  row: ResolvedAppMenuRow;
  onDone: () => void;
  onPointerEnter?: () => void;
}) {
  if (row.kind === 'separator') return <div className="wb-desk-menu-sep" role="separator" />;
  const run = row.run;
  const onClick = run ? () => {
    run();
    if (row.closeOnRun !== false) onDone();
  } : undefined;
  const label = row.suffix ? `${row.label} · ${row.suffix}` : row.label;
  if (row.radio) {
    return (
      <RadioItem
        value={row.id}
        label={label}
        checked={Boolean(row.checked)}
        disabled={row.disabled}
        testId={row.testId}
        onSelect={onClick}
        onPointerEnter={onPointerEnter}
      />
    );
  }
  return (
    <ActionItem
      icon={row.icon}
      label={label}
      shortcut={row.shortcut}
      disabled={row.disabled}
      checked={row.checked}
      danger={row.danger}
      testId={row.testId}
      onClick={onClick}
      onPointerEnter={onPointerEnter}
    />
  );
}
