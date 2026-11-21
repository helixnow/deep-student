/**
 * 空桌面恢复入口
 * ---------------------------------------------------------------------------
 * 桌面上没有任何窗口时，默认保持桌面干净、不弹出引导卡片；
 * 仅在存在可恢复的上次桌面快照时，顶部居中留一枚轻量的「恢复上次桌面」胶囊。
 * 整层 pointer-events: none，仅胶囊恢复指针，不拦截桌面右键 / 双击手势。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ClockCounterClockwise } from '@phosphor-icons/react';
import '../styles/workbench.css';
import './EmptyDesktop.css';

export interface EmptyDesktopProps {
  /** 存在可恢复的上次桌面快照时显示轻量恢复胶囊（默认 false） */
  restoreAvailable?: boolean;
  /** 可恢复快照里的窗口数（>0 时胶囊文案附带数量，帮用户预判恢复规模） */
  restoreWindowCount?: number;
  /** 「恢复上次桌面」点击回调（由总装提供 hydrate 实现） */
  onRestoreSession?: () => void;
}

export const EmptyDesktop: React.FC<EmptyDesktopProps> = React.memo(({
  restoreAvailable = false,
  restoreWindowCount = 0,
  onRestoreSession,
}) => {
  const { t } = useTranslation();

  if (!restoreAvailable || !onRestoreSession) return null;

  const restoreLabel = restoreWindowCount > 0
    ? t('workbench:emptyDesktop.actionRestoreSessionCount', { count: restoreWindowCount })
    : t('workbench:emptyDesktop.actionRestoreSession');

  return (
    <div className="wb-empty-desktop">
      <button
        type="button"
        className="wb-empty-restore-pill wb-glass"
        data-testid="wb-empty-restore-session"
        onClick={onRestoreSession}
      >
        <ClockCounterClockwise size={16} weight="duotone" aria-hidden="true" />
        {restoreLabel}
      </button>
    </div>
  );
});

EmptyDesktop.displayName = 'EmptyDesktop';
