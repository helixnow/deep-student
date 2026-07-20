import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CustomScrollArea } from '../custom-scroll-area';
import { PulseDot } from '@/components/ui/PulseDot';
import { cn } from '@/utils/cn';

interface ComparisonViewProps {
  sourceText: string;
  translatedText: string;
  srcLang: string;
  tgtLang: string;
  isTranslating: boolean;
}

/** 按段落切分；段落数不一致时降级为句子级启发式对齐 */
const splitParagraphs = (text: string): string[] =>
  text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

/**
 * 句子级切分：兼顾 CJK（。！？；）与西文（. ! ? ;）终止符，
 * 保留终止符本身，忽略纯空白片段。
 */
const splitSentences = (text: string): string[] => {
  const matches = text.match(/[^。！？；.!?;\n]+[。！？；.!?;]*/g);
  return (matches ?? []).map((s) => s.trim()).filter(Boolean);
};

interface AlignedPair {
  src: string;
  tgt: string;
}

interface AlignmentResult {
  pairs: AlignedPair[];
  /** 段落数不一致、退化到句子对齐 */
  usedSentenceFallback: boolean;
}

/**
 * 对齐策略：
 * 1. 段落数一致 → 直接按段配对（最稳）。
 * 2. 段落数不一致 → 双方按句子重切；句子数接近时按比例分桶对齐，
 *    否则仍按索引硬配对但明确提示「按句对齐」而非静默错位。
 */
const alignTexts = (sourceText: string, translatedText: string): AlignmentResult => {
  const srcParas = splitParagraphs(sourceText);
  const tgtParas = splitParagraphs(translatedText);

  if (srcParas.length === tgtParas.length || tgtParas.length === 0) {
    const maxLen = Math.max(srcParas.length, tgtParas.length);
    const pairs: AlignedPair[] = [];
    for (let i = 0; i < maxLen; i++) {
      pairs.push({ src: srcParas[i] || '', tgt: tgtParas[i] || '' });
    }
    return { pairs, usedSentenceFallback: false };
  }

  // 段落数不一致：句子级启发式
  const srcSents = splitSentences(sourceText);
  const tgtSents = splitSentences(translatedText);
  if (srcSents.length === 0 || tgtSents.length === 0) {
    const maxLen = Math.max(srcParas.length, tgtParas.length);
    const pairs: AlignedPair[] = [];
    for (let i = 0; i < maxLen; i++) {
      pairs.push({ src: srcParas[i] || '', tgt: tgtParas[i] || '' });
    }
    return { pairs, usedSentenceFallback: false };
  }

  // 以较少的一侧为行数，按比例把较多一侧的句子分桶合并
  const rows = Math.min(srcSents.length, tgtSents.length);
  const bucket = (sents: string[], rowCount: number): string[] => {
    const out: string[] = [];
    for (let i = 0; i < rowCount; i++) {
      const start = Math.round((i * sents.length) / rowCount);
      const end = Math.round(((i + 1) * sents.length) / rowCount);
      out.push(sents.slice(start, end).join(' '));
    }
    return out;
  };
  const srcRows = bucket(srcSents, rows);
  const tgtRows = bucket(tgtSents, rows);
  const pairs: AlignedPair[] = srcRows.map((src, i) => ({ src, tgt: tgtRows[i] || '' }));
  return { pairs, usedSentenceFallback: true };
};

/**
 * 双语对照视图
 *
 * - 段落级对照优先，段落数不一致时句子级启发式降级（带提示，不静默错位）
 * - hover 行时左右联动高亮
 * - 流式期间渐进渲染，缺失段展示待翻译占位
 */
export const ComparisonView: React.FC<ComparisonViewProps> = ({
  sourceText,
  translatedText,
  srcLang,
  tgtLang,
  isTranslating,
}) => {
  const { t } = useTranslation(['translation']);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const srcName = t(`translation:languages.${srcLang}`, { defaultValue: srcLang });
  const tgtName = t(`translation:languages.${tgtLang}`, { defaultValue: tgtLang });

  const { pairs, usedSentenceFallback } = useMemo(
    () => alignTexts(sourceText, translatedText),
    [sourceText, translatedText]
  );

  if (!sourceText.trim() && !translatedText.trim()) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground/50 text-sm px-6 text-center">
        {t('translation:comparison.empty')}
      </div>
    );
  }

  return (
    <CustomScrollArea className="flex-1 min-h-0">
      <div className="p-4 space-y-0">
        {/* 表头 */}
        <div className="flex items-center gap-4 pt-1 pb-3 mb-1 border-b sticky top-0 bg-background z-10">
          <div className="w-5 shrink-0" />
          <div className="flex-1 text-xs font-medium text-muted-foreground uppercase tracking-wider truncate">
            {srcName}
          </div>
          <div className="w-px h-4 bg-border shrink-0" />
          <div className="flex-1 text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2 min-w-0">
            <span className="truncate">{tgtName}</span>
            {isTranslating && (
              <span className="inline-flex items-center gap-1 text-primary shrink-0 normal-case tracking-normal">
                <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse motion-reduce:animate-none" />
                {t('translation:actions.translating')}
              </span>
            )}
            <span className="ml-auto shrink-0 normal-case tracking-normal tabular-nums text-muted-foreground/60">
              {t('translation:panel_ux.segments', { count: pairs.length })}
            </span>
          </div>
        </div>

        {/* 句子级降级提示 */}
        {usedSentenceFallback && !isTranslating && (
          <div className="mb-2 rounded-md bg-warning/10 px-3 py-1.5 text-xs text-warning">
            {t('translation:panel_ux.alignment_sentence')}
          </div>
        )}

        {/* 逐段对照 */}
        {pairs.map((pair, index) => (
          <div
            key={index}
            onMouseEnter={() => setHoverIndex(index)}
            onMouseLeave={() => setHoverIndex((prev) => (prev === index ? null : prev))}
            className={cn(
              'flex gap-4 py-3 border-b border-border/40 last:border-b-0 rounded-md -mx-2 px-2 transition-colors duration-150',
              hoverIndex === index && 'bg-[var(--interactive-hover)]'
            )}
          >
            {/* 段落序号 */}
            <div
              className={cn(
                'text-[10px] font-mono pt-0.5 w-5 shrink-0 text-right select-none transition-colors',
                hoverIndex === index ? 'text-primary/70' : 'text-muted-foreground/30'
              )}
            >
              {index + 1}
            </div>

            {/* 原文段落 */}
            <div
              className={cn(
                'flex-1 text-sm leading-relaxed whitespace-pre-wrap break-words min-w-0 transition-colors',
                hoverIndex === index ? 'text-foreground' : 'text-foreground/90'
              )}
            >
              {pair.src || (
                <span className="text-muted-foreground/30 italic text-xs">—</span>
              )}
            </div>

            {/* 分隔线 */}
            <div className="w-px bg-border/60 shrink-0 self-stretch" />

            {/* 译文段落 */}
            <div
              className={cn(
                'flex-1 text-sm leading-relaxed whitespace-pre-wrap break-words min-w-0 transition-colors',
                hoverIndex === index ? 'text-foreground' : 'text-foreground/90'
              )}
            >
              {pair.tgt ? (
                <span className={cn(isTranslating && index === pairs.length - 1 && '[animation:fade-in_0.3s_ease-out] motion-reduce:[animation:none]')}>
                  {pair.tgt}
                </span>
              ) : isTranslating ? (
                <span className="inline-flex items-center gap-1.5 text-muted-foreground/40 text-xs">
                  <PulseDot className="w-1 h-1" />
                  {t('translation:panel_ux.pending_segment')}
                </span>
              ) : (
                <span className="text-muted-foreground/30 italic text-xs">—</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </CustomScrollArea>
  );
};
