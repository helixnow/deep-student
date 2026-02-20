/**
 * 润色提升视图 — 原句 → 润色句 对比卡片
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { PolishItem } from '@/essay-grading/streamingMarkerParser';
import { ArrowRight, Sparkles, Copy, Check } from 'lucide-react';
import { NotionButton } from '@/components/ui/NotionButton';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

interface PolishSectionViewProps {
  items: PolishItem[];
  className?: string;
}

export const PolishSectionView: React.FC<PolishSectionViewProps> = ({ items, className }) => {
  const { t } = useTranslation(['essay_grading', 'common']);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const handleCopy = (text: string, index: number) => {
    copyTextToClipboard(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

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
          className="rounded-lg border border-border/30 bg-card/50 overflow-hidden group"
        >
          {/* 原句 */}
          <div className="px-4 py-3 border-b border-border/20">
            <div className="text-xs text-muted-foreground/50 mb-1">{t('essay_grading:sections.original')}</div>
            <div className="text-sm text-foreground/70 leading-relaxed">{item.original}</div>
          </div>
          {/* 润色句 */}
          <div className="px-4 py-3 bg-emerald-50/30 dark:bg-emerald-950/10 relative">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                <ArrowRight className="w-3 h-3" />
                <span>{t('essay_grading:sections.polished')}</span>
              </div>
              <CommonTooltip content={copiedIndex === index ? t('common:copied') : t('common:copy')}>
                <NotionButton
                  variant="ghost"
                  size="icon"
                  iconOnly
                  onClick={() => handleCopy(item.polished, index)}
                  className="h-6 w-6 text-emerald-600/60 hover:text-emerald-600 hover:bg-emerald-100/50 dark:hover:bg-emerald-900/30"
                >
                  {copiedIndex === index ? (
                    <Check className="w-3.5 h-3.5" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </NotionButton>
              </CommonTooltip>
            </div>
            <div className="text-sm text-foreground/85 leading-relaxed font-medium">{item.polished}</div>
          </div>
        </div>
      ))}
    </div>
  );
};
