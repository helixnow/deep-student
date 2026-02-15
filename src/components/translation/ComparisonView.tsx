import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { CustomScrollArea } from '../custom-scroll-area';

interface ComparisonViewProps {
  sourceText: string;
  translatedText: string;
  srcLang: string;
  tgtLang: string;
  isTranslating: boolean;
}

/**
 * 段落级双语对照视图
 *
 * 将源文本和译文按段落拆分，逐段对照展示
 */
export const ComparisonView: React.FC<ComparisonViewProps> = ({
  sourceText,
  translatedText,
  srcLang,
  tgtLang,
  isTranslating,
}) => {
  const { t } = useTranslation(['translation']);

  const srcName = t(`translation:languages.${srcLang}`, { defaultValue: srcLang });
  const tgtName = t(`translation:languages.${tgtLang}`, { defaultValue: tgtLang });

  const paragraphs = useMemo(() => {
    const srcParagraphs = sourceText.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    const tgtParagraphs = translatedText.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    const maxLen = Math.max(srcParagraphs.length, tgtParagraphs.length);
    const pairs: Array<{ src: string; tgt: string }> = [];
    for (let i = 0; i < maxLen; i++) {
      pairs.push({
        src: srcParagraphs[i] || '',
        tgt: tgtParagraphs[i] || '',
      });
    }
    return pairs;
  }, [sourceText, translatedText]);

  if (!sourceText.trim() && !translatedText.trim()) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground/50 text-sm">
        {t('translation:comparison.empty', { defaultValue: '输入文本并翻译后，将在此显示逐段对照' })}
      </div>
    );
  }

  return (
    <CustomScrollArea className="flex-1 min-h-0">
      <div className="p-4 space-y-0">
        {/* 表头 */}
        <div className="flex items-center gap-4 pt-1 pb-3 mb-3 border-b sticky top-0 bg-background z-10">
          <div className="w-5 shrink-0" />
          <div className="flex-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {srcName}
          </div>
          <div className="w-px h-4 bg-border shrink-0" />
          <div className="flex-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {tgtName}
            {isTranslating && (
              <span className="ml-2 inline-flex items-center gap-1 text-primary">
                <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                {t('translation:actions.translating')}
              </span>
            )}
          </div>
        </div>

        {/* 逐段对照 */}
        {paragraphs.map((pair, index) => (
          <div
            key={index}
            className="flex gap-4 py-3 border-b border-border/40 last:border-b-0 hover:bg-muted/20 transition-colors rounded-md -mx-2 px-2 group"
          >
            {/* 段落序号 */}
            <div className="text-[10px] text-muted-foreground/30 font-mono pt-0.5 w-5 shrink-0 text-right select-none">
              {index + 1}
            </div>

            {/* 原文段落 */}
            <div className="flex-1 text-sm leading-relaxed text-foreground/90 whitespace-pre-wrap break-words min-w-0">
              {pair.src || (
                <span className="text-muted-foreground/30 italic text-xs">—</span>
              )}
            </div>

            {/* 分隔线 */}
            <div className="w-px bg-border/60 shrink-0 self-stretch" />

            {/* 译文段落 */}
            <div className="flex-1 text-sm leading-relaxed text-foreground/90 whitespace-pre-wrap break-words min-w-0">
              {pair.tgt || (
                isTranslating ? (
                  <span className="inline-flex gap-0.5">
                    <span className="w-1 h-1 rounded-full bg-muted-foreground/30 animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-1 h-1 rounded-full bg-muted-foreground/30 animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="w-1 h-1 rounded-full bg-muted-foreground/30 animate-bounce" style={{ animationDelay: '300ms' }} />
                  </span>
                ) : (
                  <span className="text-muted-foreground/30 italic text-xs">—</span>
                )
              )}
            </div>
          </div>
        ))}
      </div>
    </CustomScrollArea>
  );
};
