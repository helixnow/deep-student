/**
 * 润色提升视图 — 原句 → 润色句 对比卡片
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { PolishItem } from '@/essay-grading/streamingMarkerParser';
import { ArrowRight, Sparkles } from 'lucide-react';

interface PolishSectionViewProps {
  items: PolishItem[];
  className?: string;
}

export const PolishSectionView: React.FC<PolishSectionViewProps> = ({ items, className }) => {
  const { t } = useTranslation(['essay_grading']);

  if (items.length === 0) {
    return (
      <div className={cn('flex items-center justify-center py-12 text-muted-foreground/40 text-sm', className)}>
        {t('essay_grading:sections.no_polish')}
      </div>
    );
  }

  return (
    <div className={cn('space-y-4', className)}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground/60 px-1">
        <Sparkles className="w-3.5 h-3.5" />
        <span>{t('essay_grading:sections.polish_desc')}</span>
      </div>
      {items.map((item, index) => (
        <div
          key={index}
          className="rounded-lg border border-border/30 bg-card/50 overflow-hidden"
        >
          {/* 原句 */}
          <div className="px-4 py-3 border-b border-border/20">
            <div className="text-xs text-muted-foreground/50 mb-1">{t('essay_grading:sections.original')}</div>
            <div className="text-sm text-foreground/70 leading-relaxed">{item.original}</div>
          </div>
          {/* 润色句 */}
          <div className="px-4 py-3 bg-emerald-50/30 dark:bg-emerald-950/10">
            <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 mb-1">
              <ArrowRight className="w-3 h-3" />
              <span>{t('essay_grading:sections.polished')}</span>
            </div>
            <div className="text-sm text-foreground/85 leading-relaxed font-medium">{item.polished}</div>
          </div>
        </div>
      ))}
    </div>
  );
};
