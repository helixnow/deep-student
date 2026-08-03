/**
 * StatusBarBrandMenu — 顶栏「学习桌面」品牌下拉（macOS 苹果菜单语义）
 *
 * 弹层壳（定位 / 键盘 / 焦点 / 离场）由 StatusBarMenu 提供，
 * 本文件只保留品牌菜单的动作项：全部应用 / 系统设置 / 退出学习桌面。
 */
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { GearSix, SignOut, SquaresFour } from '@phosphor-icons/react';
import { workbenchBus } from '../core/workbenchBus';
import { openAppsPanel } from './appsPanelStore';
import { ActionItem } from './DesktopContextMenu';
import { StatusBarMenu } from './StatusBarMenu';
import { persistWorkbenchModeEnabled } from '@/features/settings/components/workbenchMode';

export interface StatusBarBrandMenuProps {
  open: boolean;
  /** 品牌钮（定位锚 + 焦点归还目标） */
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

export const StatusBarBrandMenu: React.FC<StatusBarBrandMenuProps> = ({
  open,
  anchorRef,
  onClose,
}) => {
  const { t } = useTranslation('workbench');

  const runAndClose = useCallback(
    (action: () => void) => () => {
      action();
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
      <ActionItem
        icon={<SquaresFour size={15} weight="duotone" />}
        label={t('workbench:appsPanel.title')}
        testId="wb-menubar-brand-apps"
        onClick={runAndClose(() => openAppsPanel())}
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
