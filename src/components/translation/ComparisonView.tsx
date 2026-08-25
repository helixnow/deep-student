import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy } from '@phosphor-icons/react';
import { CustomScrollArea } from '../custom-scroll-area';
import { PulseDot } from '@/components/ui/PulseDot';
import { DsButton } from '@/components/ui/DsButton';
import { IconSwap } from '@/components/ui/IconSwap';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { cn } from '@/utils/cn';
// 分段/对齐规则与只读查看器（TranslationViewerWrapper）共享，保持两处一致
import { alignTexts } from '@/translation/segmentation';

interface ComparisonViewProps {
  sourceText: string;
  translatedText: string;
  srcLang: string;
  tgtLang: string;
  isTranslating: boolean;
}

/** 容器窄于该宽度时改为"原文块+译文块"纵向交错布局（双列各 <180px 时可读性崩坏） */
const NARROW_STACK_THRESHOLD = 480;

/** 触屏命中区扩展：24px（w-6 h-6）图标钮扩到 ≥44px（24 + 2×10），视觉不变
 *  （与 TranslationMain.COARSE_HIT 同款范式；此处按钮更小，inset 相应加大） */
const COARSE_HIT =
  "relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-2.5 [@media(pointer:coarse)]:after:content-['']";

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
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  // 容器级窄屏检测：面板可能只占视口一半（分栏）或运行在 workbench 浮窗，
  // 视口断点在此不可靠，以自身实测宽度决定双列 / 纵向交错。
  // callback ref：空态提前 return 时容器不存在，出现内容后再挂载也能正确开始观察
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const [isNarrow, setIsNarrow] = useState(false);
  const setContainerRef = useCallback((node: HTMLDivElement | null) => {
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const update = () => setIsNarrow(node.clientWidth < NARROW_STACK_THRESHOLD);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(node);
    resizeObserverRef.current = ro;
  }, []);
  useEffect(() => () => resizeObserverRef.current?.disconnect(), []);

  useEffect(() => () => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
  }, []);

  const handleCopySegment = useCallback(async (index: number, text: string) => {
    try {
      await copyTextToClipboard(text);
      setCopiedIndex(index);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopiedIndex(null), 2000);
    } catch (error: unknown) {
      console.error('[ComparisonView] Copy segment failed:', error);
    }
  }, []);

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
      <div ref={setContainerRef} className="p-4 space-y-0">
        {/* 表头（窄容器合并为单行：语向 + 状态 + 段数） */}
        {isNarrow ? (
          <div className="flex items-center gap-2 pt-1 pb-3 mb-1 border-b sticky top-0 bg-background z-10 text-xs font-medium text-muted-foreground min-w-0">
            <span className="truncate uppercase tracking-wider">
              {srcName} → {tgtName}
            </span>
            {isTranslating && (
              <span className="inline-flex items-center gap-1 text-primary shrink-0">
                <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse motion-reduce:animate-none" />
                {t('translation:actions.translating')}
              </span>
            )}
            <span className="ml-auto shrink-0 tabular-nums text-muted-foreground/60">
              {t('translation:panel_ux.segments', { count: pairs.length })}
            </span>
          </div>
        ) : (
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
        )}

        {/* 句子级降级提示 */}
        {usedSentenceFallback && !isTranslating && (
          <div className="mb-2 rounded-md bg-warning/10 px-3 py-1.5 text-xs text-warning">
            {t('translation:panel_ux.alignment_sentence')}
          </div>
        )}

        {/* 逐段对照：hover 联动高亮走纯 CSS（group），长文档 hover 不触发整表重渲染 */}
        {pairs.map((pair, index) => {
          const copyButton = pair.tgt ? (
            <DsButton
              variant="ghost"
              size="icon"
              onClick={() => void handleCopySegment(index, pair.tgt)}
              aria-label={t('translation:comparison_ux.copy_segment')}
              title={
                copiedIndex === index
                  ? t('translation:popover.copied')
                  : t('translation:comparison_ux.copy_segment')
              }
              className={cn(
                COARSE_HIT,
                'w-6 h-6 shrink-0 transition-opacity',
                isNarrow ? '' : 'absolute right-1 top-2.5',
                copiedIndex === index
                  ? 'opacity-100 text-success hover:text-success'
                  : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-60 text-muted-foreground/60 hover:text-foreground',
              )}
            >
              <IconSwap
                active={copiedIndex === index}
                a={<Copy size={13} aria-hidden="true" />}
                b={<Check size={13} aria-hidden="true" />}
              />
            </DsButton>
          ) : null;

          const tgtContent = pair.tgt ? (
            <span className={cn(isTranslating && index === pairs.length - 1 && 'ui-fade-in')}>
              {pair.tgt}
            </span>
          ) : isTranslating ? (
            <span className="inline-flex items-center gap-1.5 text-muted-foreground/40 text-xs">
              <PulseDot className="w-1 h-1" />
              {t('translation:panel_ux.pending_segment')}
            </span>
          ) : (
            <span className="text-muted-foreground/30 italic text-xs">—</span>
          );

          if (isNarrow) {
            // 窄容器：原文块 + 译文块纵向交错，序号与复制按钮并入段头行
            return (
              <div
                key={index}
                className="group relative flex flex-col gap-1.5 py-3 border-b border-border/40 last:border-b-0 rounded-md -mx-2 px-2 transition-colors duration-150 hover:bg-[var(--interactive-hover)]"
              >
                <div className="flex items-center gap-2 min-h-6">
                  <span className="text-[10px] font-mono select-none transition-colors text-muted-foreground/40 group-hover:text-primary/70">
                    {index + 1}
                  </span>
                  <span className="ml-auto">{copyButton}</span>
                </div>
                <div className="text-sm leading-relaxed whitespace-pre-wrap break-words min-w-0 text-foreground/90">
                  {pair.src || <span className="text-muted-foreground/30 italic text-xs">—</span>}
                </div>
                <div className="text-sm leading-relaxed whitespace-pre-wrap break-words min-w-0 text-foreground/90 border-l-2 border-primary/30 pl-2.5">
                  {tgtContent}
                </div>
              </div>
            );
          }

          return (
            <div
              key={index}
              className="group relative flex gap-4 py-3 border-b border-border/40 last:border-b-0 rounded-md -mx-2 px-2 transition-colors duration-150 hover:bg-[var(--interactive-hover)]"
            >
              {/* 段落序号 */}
              <div className="text-[10px] font-mono pt-0.5 w-5 shrink-0 text-right select-none transition-colors text-muted-foreground/30 group-hover:text-primary/70">
                {index + 1}
              </div>

              {/* 原文段落 */}
              <div className="flex-1 text-sm leading-relaxed whitespace-pre-wrap break-words min-w-0 transition-colors text-foreground/90 group-hover:text-foreground">
                {pair.src || (
                  <span className="text-muted-foreground/30 italic text-xs">—</span>
                )}
              </div>

              {/* 分隔线 */}
              <div className="w-px bg-border/60 shrink-0 self-stretch" />

              {/* 译文段落 */}
              <div className="flex-1 text-sm leading-relaxed whitespace-pre-wrap break-words min-w-0 transition-colors text-foreground/90 group-hover:text-foreground pr-6">
                {tgtContent}
              </div>

              {/* 逐段复制（复制该段译文；hover / 键盘聚焦 / 触屏可见） */}
              {copyButton}
            </div>
          );
        })}
      </div>
    </CustomScrollArea>
  );
};
