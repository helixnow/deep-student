import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen, Eye, EyeOff, X } from 'lucide-react';
import { NotionButton } from '@/components/ui/NotionButton';
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

  return (
    <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2 rounded-xl bg-[var(--mm-bg-elevated)] border border-[var(--mm-border)] shadow-lg backdrop-blur">
      <BookOpen className="w-4 h-4 text-amber-500 shrink-0" />
      <span className="text-sm font-medium whitespace-nowrap">{t('recite.title')}</span>

      {progress.total > 0 ? (
        <div className="flex items-center gap-2">
          <div className="w-24 h-1.5 rounded-full bg-[var(--mm-border)] overflow-hidden">
            <div
              className="h-full rounded-full bg-amber-500 transition-all duration-300"
              style={{ width: `${(progress.revealed / progress.total) * 100}%` }}
            />
          </div>
          <span className="text-xs text-[var(--mm-text-muted)] whitespace-nowrap tabular-nums">
            {progress.revealed}/{progress.total}
          </span>
        </div>
      ) : (
        <span className="text-xs text-[var(--mm-text-muted)] whitespace-nowrap max-w-[200px] truncate">
          {t('recite.emptyHint')}
        </span>
      )}

      <div className="w-px h-4 bg-[var(--mm-border)]" />
      <NotionButton variant="ghost" onClick={revealAllBlanks} className="h-7 px-2 text-xs gap-1" disabled={progress.total === 0}>
        <Eye className="w-3.5 h-3.5" />
        {t('recite.revealAll')}
      </NotionButton>
      <NotionButton variant="ghost" onClick={resetAllBlanks} className="h-7 px-2 text-xs gap-1" disabled={progress.total === 0}>
        <EyeOff className="w-3.5 h-3.5" />
        {t('recite.resetAll')}
      </NotionButton>
      <NotionButton variant="ghost" onClick={() => setReciteMode(false)} className="h-7 px-2 text-xs gap-1">
        <X className="w-3.5 h-3.5" />
        {t('recite.exit')}
      </NotionButton>
    </div>
  );
};
