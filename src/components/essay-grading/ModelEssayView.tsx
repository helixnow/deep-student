/**
 * 参考范文视图 — 渲染 AI 生成的参考范文
 * 支持复制、字数统计、首行缩进排版、可选衬线字体
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { BookOpen, Copy, Check, TextT } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

interface ModelEssayViewProps {
  essay: string;
  className?: string;
}

/** 字数统计：CJK 逐字 + 拉丁文按词 */
function countWords(text: string): number {
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? []).length;
  const latinWords = (text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) ?? []).length;
  return cjkCount + latinWords;
}

export const ModelEssayView: React.FC<ModelEssayViewProps> = ({ essay, className }) => {
  const { t } = useTranslation(['essay_grading', 'common']);
  const [copied, setCopied] = useState(false);
  const [serif, setSerif] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const trimmed = essay?.trim() ?? '';

  const paragraphs = useMemo(
    () => trimmed.split(/\n+/).map((p) => p.trim()).filter(Boolean),
    [trimmed]
  );

  const wordCount = useMemo(() => countWords(trimmed), [trimmed]);

  if (!trimmed) {
    return (
      <div className={cn('flex flex-col items-center justify-center py-16 gap-2 select-none', className)}>
        <BookOpen size={28} className="text-muted-foreground/30" />
        <div className="text-sm font-medium text-muted-foreground/70">
          {t('essay_grading:sections.no_model_essay')}
        </div>
        <div className="text-xs text-muted-foreground/45">
          {t('essay_grading:sections.no_model_essay_desc')}
        </div>
      </div>
    );
  }

  const handleCopy = () => {
    copyTextToClipboard(trimmed);
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={cn('space-y-4', className)}>
      {/* 工具行：说明 + 字数 + 衬线切换 + 复制 */}
      <div className="flex items-center gap-2 px-1 flex-wrap">
        <div className="flex items-center gap-2 text-xs text-muted-foreground/60 min-w-0">
          <BookOpen size={14} className="shrink-0" />
          <span className="truncate">{t('essay_grading:sections.model_essay_desc')}</span>
        </div>
        <div className="flex-1" />
        <span className="text-xs text-muted-foreground/50 tabular-nums shrink-0">
          {t('essay_grading:sections.model_essay_word_count', { total: wordCount })}
        </span>
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          aria-label={t('essay_grading:sections.serif_toggle')}
          aria-pressed={serif}
          onClick={() => setSerif((v) => !v)}
          className={cn(
            'w-6 h-6 transition-colors duration-150 motion-reduce:transition-none',
            serif ? 'bg-primary/10 text-primary' : 'text-muted-foreground/50 hover:text-foreground'
          )}
        >
          <TextT size={13} />
        </DsButton>
        <DsButton
          variant="ghost"
          size="sm"
          aria-label={copied ? t('essay_grading:sections.copied') : t('common:copy')}
          onClick={handleCopy}
          className={cn(
            'h-6 px-1.5 gap-1 text-xs transition-colors duration-200 motion-reduce:transition-none',
            copied
              ? 'text-success hover:text-success'
              : 'text-muted-foreground/50 hover:text-foreground'
          )}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <span>{copied ? t('essay_grading:sections.copied') : t('common:copy')}</span>
        </DsButton>
      </div>

      {/* 正文：首行缩进 + 段间距，可选 serif */}
      <div className="rounded-xl border border-border/40 bg-card/50 px-6 py-5">
        <div
          className={cn(
            'text-[15px] leading-[1.9] text-foreground/85 space-y-3',
            serif && 'font-serif'
          )}
        >
          {paragraphs.map((paragraph, index) => (
            <p key={index} style={{ textIndent: '2em' }}>
              {paragraph}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
};
