/**
 * StatusBarBrandMenu — 顶栏「学习桌面」品牌下拉（macOS 苹果菜单语义）
 *
 * 弹层壳（定位 / 键盘 / 焦点 / 离场）由 StatusBarMenu 提供，
 * 本文件保留品牌菜单的动作项：全部应用 / 系统设置 / 退出学习桌面，
 * 以及 Spaces 最小命名桌面的展示与重命名入口（desktopNameStore）：
 * 菜单头显示当前桌面名（未命名回退 menubar.appName），「重命名桌面…」把
 * 菜单头切换为内联输入（Enter 提交、Esc 取消；输入框内按键不进菜单漫游焦点）。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GearSix, Keyboard, PencilSimple, SignOut, SquaresFour } from '@phosphor-icons/react';
import { workbenchBus } from '../core/workbenchBus';
import {
  WORKBENCH_SHORTCUT_DEFINITIONS,
  formatShortcutBinding,
  useWorkbenchOverlay,
} from '../core/shortcuts';
import { DESKTOP_NAME_MAX_LENGTH } from '../core/persistedSettings';
import { openAppsPanel } from './appsPanelStore';
import { ActionItem } from './DesktopContextMenu';
import { StatusBarMenu } from './StatusBarMenu';
import { persistDesktopName, useDesktopName } from './desktopNameStore';
import { persistWorkbenchModeEnabled } from '@/features/settings/components/workbenchMode';

export interface StatusBarBrandMenuProps {
  open: boolean;
  /** 品牌钮（定位锚 + 焦点归还目标） */
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

/** 速查表键位提示（平台相关，渲染时求值而非模块初始化时） */
function cheatsheetShortcutHint(): string | undefined {
  const definition = WORKBENCH_SHORTCUT_DEFINITIONS.find((item) => item.id === 'cheatsheet');
  return definition ? formatShortcutBinding(definition.binding) : undefined;
}

export const StatusBarBrandMenu: React.FC<StatusBarBrandMenuProps> = ({
  open,
  anchorRef,
  onClose,
}) => {
  const { t } = useTranslation('workbench');
  const desktopName = useDesktopName();
  // 内联重命名相位：菜单头 ↔ 输入框互换；菜单关闭时复位（下次打开回展示态）
  const [renaming, setRenaming] = useState(false);
  useEffect(() => {
    if (!open) setRenaming(false);
  }, [open]);

  const runAndClose = useCallback(
    (action: () => void) => () => {
      action();
      onClose();
    },
    [onClose],
  );

  const commitRename = useCallback(
    (value: string) => {
      // 清洗 / 截断 / 空值清除统一在 persistDesktopName 内完成
      void persistDesktopName(value);
      onClose();
    },
    [onClose],
  );

  return (
    <StatusBarMenu
      open={open}
      anchorRef={anchorRef}
      label={t('menubar.brandMenu')}
      onClose={onClose}
    >
      {renaming ? (
        <form
          className="wb-desk-menu-rename"
          data-testid="wb-menubar-brand-rename-form"
          onSubmit={(e) => {
            e.preventDefault();
            const input = e.currentTarget.elements.namedItem('desktopName');
            commitRename(input instanceof HTMLInputElement ? input.value : '');
          }}
        >
          <input
            name="desktopName"
            className="wb-desk-menu-rename-input"
            data-testid="wb-menubar-brand-rename-input"
            defaultValue={desktopName ?? ''}
            maxLength={DESKTOP_NAME_MAX_LENGTH * 2}
            aria-label={t('menubar.desktopNameInputLabel')}
            placeholder={t('menubar.appName')}
            autoFocus
            onKeyDown={(e) => {
              // 输入框内按键（含 ↑↓/Home/End/Esc）不进菜单漫游焦点与关闭链
              e.stopPropagation();
              if (e.key === 'Escape') {
                e.preventDefault();
                setRenaming(false);
              }
            }}
          />
        </form>
      ) : (
        <div
          className="wb-desk-menu-header"
          role="presentation"
          data-testid="wb-menubar-brand-desktop-name"
        >
          <span className="wb-desk-menu-header-name">
            {desktopName ?? t('menubar.appName')}
          </span>
          {desktopName !== null ? (
            <span className="wb-desk-menu-header-sub">{t('menubar.appName')}</span>
          ) : null}
        </div>
      )}
      <ActionItem
        icon={<PencilSimple size={15} weight="duotone" />}
        label={t('menubar.desktopRename')}
        testId="wb-menubar-brand-rename"
        onClick={() => setRenaming(true)}
      />
      <div className="wb-desk-menu-sep" role="separator" />
      <ActionItem
        icon={<SquaresFour size={15} weight="duotone" />}
        label={t('workbench:appsPanel.title')}
        testId="wb-menubar-brand-apps"
        onClick={runAndClose(() => openAppsPanel())}
      />
      {/* 速查表的常驻可发现入口（`?` 快捷键之外的第二条路径） */}
      <ActionItem
        icon={<Keyboard size={15} weight="duotone" />}
        label={t('workbench:desktopMenu.shortcuts')}
        shortcut={cheatsheetShortcutHint()}
        testId="wb-menubar-brand-shortcuts"
        onClick={runAndClose(() =>
          useWorkbenchOverlay.getState().openCheatsheet({ sticky: true }),
        )}
      />
      <ActionItem
        icon={<GearSix size={15} weight="duotone" />}
        label={t('menubar.brandSettings')}
        testId="wb-menubar-brand-settings"
        onClick={runAndClose(() => workbenchBus.launch({ typeId: 'settings', reason: 'api' }))}
      />
      <div className="wb-desk-menu-sep" role="separator" />
      <ActionItem
        icon={<SignOut size={15} weight="duotone" />}
        label={t('menubar.brandExit')}
        testId="wb-menubar-brand-exit"
        onClick={runAndClose(() => {
          // 失败由 helper 统一通知；成功后 App 监听 workbench:mode-changed 切回 legacy 壳
          void persistWorkbenchModeEnabled(false);
        })}
      />
    </StatusBarMenu>
  );
};

export default StatusBarBrandMenu;
