/**
 * 参考范文视图 — 渲染 AI 生成的参考范文
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { BookOpen } from 'lucide-react';

interface ModelEssayViewProps {
  essay: string;
  className?: string;
}

export const ModelEssayView: React.FC<ModelEssayViewProps> = ({ essay, className }) => {
  const { t } = useTranslation(['essay_grading']);

  if (!essay || !essay.trim()) {
    return (
      <div className={cn('flex items-center justify-center py-12 text-muted-foreground/40 text-sm', className)}>
        {t('essay_grading:sections.no_model_essay')}
      </div>
    );
  }

  return (
    <div className={cn('space-y-4', className)}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground/60 px-1">
        <BookOpen className="w-3.5 h-3.5" />
        <span>{t('essay_grading:sections.model_essay_desc')}</span>
      </div>
      <div className="rounded-lg border border-border/30 bg-card/50 px-5 py-4">
        <div className="text-[15px] leading-[1.8] text-foreground/85 whitespace-pre-wrap">
          {essay}
        </div>
      </div>
    </div>
  );
};
