import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen, Eye, EyeSlash, X } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { useMindMapStore } from '../../store';
import { countBlankProgress } from '../../utils/node/blankRanges';

export const ReciteStatusBar: React.FC = () => {
  const { t } = useTranslation('mindmap');
  const reciteMode = useMindMapStore(s => s.reciteMode);
  const document = useMindMapStore(s => s.document);
  const revealedBlanks = useMindMapStore(s => s.revealedBlanks);
  const revealAllBlanks = useMindMapStore(s => s.revealAllBlanks);
  const resetAllBlanks = useMindMapStore(s => s.resetAllBlanks);
  const setReciteMode = useMindMapStore(s => s.setReciteMode);

  const progress = useMemo(() => {
    if (!reciteMode) return { total: 0, revealed: 0 };
    return countBlankProgress(document.root, revealedBlanks);
  }, [reciteMode, document.root, revealedBlanks]);

  if (!reciteMode) return null;

  // 顶部内联占位条：占用文档流（父容器 flex-col），不再作为悬浮层遮挡画布顶部节点
  return (
    <div className="mm-recite-status-bar shrink-0 z-30 flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5 border-b border-[var(--mm-border)] bg-[var(--mm-bg-elevated)] ui-drop-in">
      <BookOpen className="w-4 h-4 text-[var(--mm-warning)] shrink-0" />
      <span className="text-sm font-medium whitespace-nowrap">{t('recite.title')}</span>

      {progress.total > 0 ? (
        <div className="flex items-center gap-2">
          <div className="w-24 h-1.5 rounded-full bg-[var(--mm-border)] overflow-hidden">
            <div
              className="h-full rounded-full bg-[var(--mm-warning)] transition-all duration-300 motion-reduce:transition-none"
              style={{ width: `${(progress.revealed / progress.total) * 100}%` }}
            />
          </div>
          <span className="text-xs text-[var(--mm-text-muted)] whitespace-nowrap tabular-nums">
            {progress.revealed}/{progress.total}
          </span>
        </div>
      ) : (
        <DsButton
          variant="ghost"
          className="mm-recite-status-action h-7 px-2 text-xs"
          onClick={() => setReciteMode(false)}
        >
          {t('recite.createBlankCta')}
        </DsButton>
      )}

      <div className="w-px h-4 bg-[var(--mm-border)]" />
      <DsButton variant="ghost" onClick={revealAllBlanks} className="mm-recite-status-action h-7 px-2 text-xs gap-1" disabled={progress.total === 0}>
        <Eye size={14} />
        {t('recite.revealAll')}
      </DsButton>
      <DsButton variant="ghost" onClick={resetAllBlanks} className="mm-recite-status-action h-7 px-2 text-xs gap-1" disabled={progress.total === 0}>
        <EyeSlash size={14} />
        {t('recite.resetAll')}
      </DsButton>
      <DsButton variant="ghost" onClick={() => setReciteMode(false)} className="mm-recite-status-action h-7 px-2 text-xs gap-1">
        <X size={14} />
        {t('recite.exit')}
      </DsButton>
    </div>
  );
};
