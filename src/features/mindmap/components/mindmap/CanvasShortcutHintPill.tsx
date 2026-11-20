import React from 'react';
import { useTranslation } from 'react-i18next';
import { CaretLeft, Keyboard, Question } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/shad/Tooltip';
import { useCanvasShortcutHintMode } from '../../hooks/useCanvasDragMode';

export interface CanvasShortcutHintPillProps {
  reciteMode: boolean;
  onOpenShortcuts?: () => void;
}

const kbdClassName =
  'inline-flex h-4 items-center justify-center rounded border border-[var(--mm-border)] bg-[var(--mm-bg)] px-1 font-mono text-2xs font-medium leading-none text-[var(--mm-text)]';

/**
 * 画布左下角快捷键轻提示胶囊（桌面端常驻，支持一键收起并持久化偏好）。
 *
 * - 编辑态：提示 Tab 子节点 · Enter 同级 · Space/双击 编辑，降低新手面对画布不知如何快速扩写的门槛；
 * - 背诵（挖空复习）态：自动切换为 ↑↓←→ 导航 · Space 揭示下一空 · Esc 退出；
 * - 收起态：保留极简键盘图标入口，随时一键展开。
 */
export const CanvasShortcutHintPill: React.FC<CanvasShortcutHintPillProps> = ({
  reciteMode,
  onOpenShortcuts,
}) => {
  const { t } = useTranslation('mindmap');
  const [hintMode, setHintMode] = useCanvasShortcutHintMode();

  if (hintMode === 'collapsed') {
    return (
      <div className="absolute bottom-3 left-14 z-20 hidden lg:inline-flex">
        <Tooltip>
          <TooltipTrigger asChild>
            <DsButton
              variant="ghost"
              size="sm"
              iconOnly
              className="h-8 w-8 rounded-[10px] border border-[var(--mm-border)] bg-[var(--mm-bg-elevated)] text-[var(--mm-text-secondary)] shadow-[var(--mm-shadow)] backdrop-blur-md hover:bg-[var(--mm-bg-hover)] hover:text-[var(--mm-text)] active:scale-95 transition-all duration-150 motion-reduce:transition-none motion-reduce:transform-none"
              onClick={() => setHintMode('expanded')}
              aria-label={t('canvasV2.expandHints')}
              data-testid="mm-shortcut-hint-expand"
            >
              <Keyboard size={15} />
            </DsButton>
          </TooltipTrigger>
          <TooltipContent side="top">{t('canvasV2.expandHints')}</TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <div
      role="region"
      aria-label={t('canvasV2.quickHintsLabel')}
      data-testid="mm-shortcut-hint-pill"
      className="absolute bottom-3 left-14 z-20 hidden lg:inline-flex h-8 items-center gap-1.5 rounded-[10px] border border-[var(--mm-border)] bg-[var(--mm-bg-elevated)] pl-2.5 pr-1 text-2xs text-[var(--mm-text-secondary)] shadow-[var(--mm-shadow)] backdrop-blur-md select-none transition-all duration-150 motion-reduce:transition-none"
    >
      <Keyboard size={14} className="shrink-0 text-[var(--mm-text-muted)]" aria-hidden="true" />
      {reciteMode ? (
        <div className="inline-flex items-center gap-1.5">
          <span className="inline-flex items-center gap-1">
            <kbd className={kbdClassName}>↑↓←→</kbd>
            <span>{t('canvasV2.hintReciteNav')}</span>
          </span>
          <span className="text-[var(--mm-text-muted)]" aria-hidden="true">·</span>
          <span className="inline-flex items-center gap-1">
            <kbd className={kbdClassName}>Space</kbd>
            <span>{t('canvasV2.hintReciteReveal')}</span>
          </span>
          <span className="text-[var(--mm-text-muted)]" aria-hidden="true">·</span>
          <span className="inline-flex items-center gap-1">
            <kbd className={kbdClassName}>Esc</kbd>
            <span>{t('canvasV2.hintReciteExit')}</span>
          </span>
        </div>
      ) : (
        <div className="inline-flex items-center gap-1.5">
          <span className="inline-flex items-center gap-1">
            <kbd className={kbdClassName}>Tab</kbd>
            <span>{t('canvasV2.hintChild')}</span>
          </span>
          <span className="text-[var(--mm-text-muted)]" aria-hidden="true">·</span>
          <span className="inline-flex items-center gap-1">
            <kbd className={kbdClassName}>Enter</kbd>
            <span>{t('canvasV2.hintSibling')}</span>
          </span>
          <span className="text-[var(--mm-text-muted)]" aria-hidden="true">·</span>
          <span className="inline-flex items-center gap-1">
            <kbd className={kbdClassName}>Space</kbd>
            <span>
              /{t('canvasV2.hintDoubleClick')} {t('canvasV2.hintEdit')}
            </span>
          </span>
        </div>
      )}
      <span className="mx-0.5 h-3.5 w-px bg-[var(--mm-border)]" aria-hidden="true" />
      {onOpenShortcuts && (
        <Tooltip>
          <TooltipTrigger asChild>
            <DsButton
              variant="ghost"
              size="sm"
              iconOnly
              className="!h-6 !w-6 !min-w-0 rounded-[7px] text-[var(--mm-text-muted)] hover:bg-[var(--mm-bg-hover)] hover:text-[var(--mm-text)] active:scale-95 transition-all duration-100 motion-reduce:transition-none motion-reduce:transform-none"
              onClick={onOpenShortcuts}
              aria-label={t('canvasV2.openAllShortcuts')}
              data-testid="mm-shortcut-hint-more"
            >
              <Question size={13} />
            </DsButton>
          </TooltipTrigger>
          <TooltipContent side="top">{t('canvasV2.openAllShortcuts')}</TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <DsButton
            variant="ghost"
            size="sm"
            iconOnly
            className="!h-6 !w-6 !min-w-0 rounded-[7px] text-[var(--mm-text-muted)] hover:bg-[var(--mm-bg-hover)] hover:text-[var(--mm-text)] active:scale-95 transition-all duration-100 motion-reduce:transition-none motion-reduce:transform-none"
            onClick={() => setHintMode('collapsed')}
            aria-label={t('canvasV2.collapseHints')}
            data-testid="mm-shortcut-hint-collapse"
          >
            <CaretLeft size={13} />
          </DsButton>
        </TooltipTrigger>
        <TooltipContent side="top">{t('canvasV2.collapseHints')}</TooltipContent>
      </Tooltip>
    </div>
  );
};
