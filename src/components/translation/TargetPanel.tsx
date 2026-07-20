import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NotionButton } from '@/components/ui/NotionButton';
import { Textarea } from '../ui/shad/Textarea';
import { Switch } from '../ui/shad/Switch';
import { Label } from '../ui/shad/Label';
import { CommonTooltip } from '../shared/CommonTooltip';
import {
    Translate,
    PencilSimple,
    SpeakerHigh,
    Copy,
    Check,
    Download,
    CheckCircle,
    Star,
    Columns,
} from '@phosphor-icons/react';
import { cn } from '@/utils/cn';
import { TranslationStreamRenderer } from '../../translation/TranslationStreamRenderer';
import { ComparisonView } from './ComparisonView';

interface TargetPanelProps {
    sourceText: string;
    srcLang: string;
    tgtLang: string;
    translatedText: string;
    isTranslating: boolean;
    isSyncScroll: boolean;
    setIsSyncScroll: (val: boolean) => void;
    isEditingTranslation: boolean;
    editedTranslation: string;
    setEditedTranslation: (text: string) => void;
    onCancelEdit: () => void;
    onSaveEditedTranslation: () => void;
    translationQuality: number | null;
    onRateTranslation: (rating: number) => void;
    targetCharCount: number;
    onEditTranslation: () => void;
    onSpeak: () => void;
    isSpeaking: boolean;
    onCopyResult: () => void;
    onExportTranslation: () => void;
}

const COPY_FEEDBACK_MS = 1500;

/** 触屏命中区扩展：32px 图标钮扩到 ≥44px，视觉不变（与 InputBarUI.coarseHitAreaClass 同款范式） */
const COARSE_HIT =
    "relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-1.5 [@media(pointer:coarse)]:after:content-['']";

/** 同步滚动契约：把实际滚动元素标记为 data-translation-scroll="target" */
const SCROLL_ROLE_ATTR = 'data-translation-scroll';
const VIEWPORT_SELECTOR = '[data-overlayscrollbars-viewport], .scroll-area--native';

/**
 * 译文面板：流式渲染 / 段落对照 / 内联编辑三态切换。
 */
export const TargetPanel = React.forwardRef<HTMLDivElement, TargetPanelProps>(({
    sourceText,
    srcLang,
    tgtLang,
    translatedText,
    isTranslating,
    isSyncScroll,
    setIsSyncScroll,
    isEditingTranslation,
    editedTranslation,
    setEditedTranslation,
    onCancelEdit,
    onSaveEditedTranslation,
    translationQuality,
    onRateTranslation,
    onEditTranslation,
    onSpeak,
    isSpeaking,
    onCopyResult,
    onExportTranslation,
}, ref) => {
    const { t } = useTranslation(['translation', 'common']);
    const [showComparison, setShowComparison] = useState(false);

    // 译文统计：面板内部自行计算，不信任外部传入（历史上曾误传原文统计）
    const targetCharCount = translatedText.length;

    // ===== 复制按钮成功态 =====
    const [justCopied, setJustCopied] = useState(false);
    const copyTimerRef = useRef<number | null>(null);
    const handleCopy = useCallback(() => {
        onCopyResult();
        setJustCopied(true);
        if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = window.setTimeout(() => {
            setJustCopied(false);
            copyTimerRef.current = null;
        }, COPY_FEEDBACK_MS);
    }, [onCopyResult]);
    useEffect(() => () => {
        if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    }, []);

    // ===== 同步滚动契约：把内容区实际滚动元素打上 target 标记 =====
    // 流式渲染器的滚动 viewport 在其内部组件里，无法直接挂属性，
    // 这里在视图形态变化后查找并标记（编辑态 Textarea 直接内联该属性）。
    const contentWrapRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        if (isEditingTranslation) return;
        const wrap = contentWrapRef.current;
        if (!wrap) return;
        const viewport = wrap.querySelector<HTMLElement>(VIEWPORT_SELECTOR);
        if (viewport && viewport.getAttribute(SCROLL_ROLE_ATTR) !== 'target') {
            viewport.setAttribute(SCROLL_ROLE_ATTR, 'target');
        }
    }, [isEditingTranslation, showComparison, translatedText, isTranslating]);

    const setContentWrap = useCallback((node: HTMLDivElement | null) => {
        contentWrapRef.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
    }, [ref]);

    const copyIcon = justCopied ? (
        <Check size={16} className="text-success" />
    ) : (
        <Copy size={16} />
    );

    return (
        <div className="flex flex-col h-full min-h-0 flex-1 basis-1/2 min-w-0 bg-muted/10 group/target">
            {/* 桌面工具栏 */}
            <div data-wb-blur-surface className="hidden sm:flex items-center justify-between px-4 h-10 border-b border-border/50 bg-background/50 backdrop-blur z-10 shrink-0">
                <span className="text-sm text-foreground/70 flex items-center gap-1.5 min-w-0 truncate">
                    <Translate size={14} className="shrink-0 text-muted-foreground" />
                    {t('translation:target_section.title')}
                </span>

                <div className="flex items-center gap-1 shrink-0">
                    {/* 对照切换（tooltip 带用途说明，帮助首次用户理解该视图） */}
                    <CommonTooltip content={`${t('translation:comparison.toggle')} · ${t('translation:tabs.comparison_description')}`}>
                        <NotionButton
                            variant="ghost"
                            size="icon"
                            onClick={() => setShowComparison(!showComparison)}
                            disabled={isEditingTranslation}
                            aria-pressed={showComparison}
                            aria-label={t('translation:comparison.toggle')}
                            className={cn(
                                COARSE_HIT,
                                'h-8 w-8 transition-colors',
                                showComparison
                                    ? 'text-primary bg-primary/10'
                                    : 'text-muted-foreground hover:text-foreground'
                            )}
                        >
                            <Columns size={16} />
                        </NotionButton>
                    </CommonTooltip>

                    {/* 同步滚动（lg+ 由顶部工具栏承载，这里只补足中等宽度） */}
                    <div className="flex lg:hidden items-center gap-2 mr-2 px-2 py-1 rounded-md hover:bg-[var(--interactive-hover)] transition-colors">
                        <Switch
                            id="target-sync-scroll"
                            checked={isSyncScroll}
                            onCheckedChange={setIsSyncScroll}
                            className="data-[state=checked]:bg-primary"
                        />
                        <Label htmlFor="target-sync-scroll" className="text-xs font-medium text-muted-foreground cursor-pointer whitespace-nowrap">
                            {t('translation:sync_scroll')}
                        </Label>
                    </div>

                    {translatedText && (
                        <>
                            <div className="w-px h-4 bg-border mx-1" />
                            <CommonTooltip content={t('translation:target_section.edit')}>
                                <NotionButton
                                    variant="ghost"
                                    size="icon"
                                    onClick={onEditTranslation}
                                    disabled={isEditingTranslation || isTranslating}
                                    aria-label={t('translation:target_section.edit')}
                                    className={cn(COARSE_HIT, "w-8 h-8 text-muted-foreground hover:text-foreground")}
                                >
                                    <PencilSimple size={16} />
                                </NotionButton>
                            </CommonTooltip>
                            <CommonTooltip content={isSpeaking ? t('translation:target_section.stop_listen') : t('translation:target_section.listen')}>
                                <NotionButton
                                    variant="ghost"
                                    size="icon"
                                    onClick={onSpeak}
                                    disabled={!translatedText || isEditingTranslation || isTranslating}
                                    aria-label={isSpeaking ? t('translation:target_section.stop_listen') : t('translation:target_section.listen')}
                                    className={cn(
                                        COARSE_HIT,
                                        'h-8 w-8 transition-colors',
                                        isSpeaking ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground'
                                    )}
                                >
                                    <SpeakerHigh size={16} className={isSpeaking ? 'animate-pulse motion-reduce:animate-none' : ''} />
                                </NotionButton>
                            </CommonTooltip>
                            <CommonTooltip content={justCopied ? t('translation:target_section.copied') : t('translation:target_section.copy')}>
                                <NotionButton
                                    variant="ghost"
                                    size="icon"
                                    onClick={handleCopy}
                                    disabled={isTranslating}
                                    aria-label={t('translation:target_section.copy')}
                                    className={cn(COARSE_HIT, "w-8 h-8 text-muted-foreground hover:text-foreground")}
                                >
                                    {copyIcon}
                                </NotionButton>
                            </CommonTooltip>
                            <CommonTooltip content={t('translation:target_section.export')}>
                                <NotionButton
                                    variant="ghost"
                                    size="icon"
                                    onClick={onExportTranslation}
                                    disabled={isTranslating}
                                    aria-label={t('translation:target_section.export')}
                                    className={cn(COARSE_HIT, "w-8 h-8 text-muted-foreground hover:text-foreground")}
                                >
                                    <Download size={16} />
                                </NotionButton>
                            </CommonTooltip>
                        </>
                    )}
                </div>
            </div>

            {/* 移动端操作栏 */}
            {translatedText && !isEditingTranslation && (
                <div className="sm:hidden flex items-center justify-between px-3 h-10 border-b border-border/50 bg-background/50 shrink-0">
                    <span className="text-xs text-muted-foreground flex items-center gap-1 min-w-0 truncate">
                        <Translate size={13} className="shrink-0" />
                        {t('translation:target_section.title')}
                        <span className="tabular-nums text-muted-foreground/60">· {targetCharCount.toLocaleString()}</span>
                    </span>
                    <div className="flex items-center gap-0.5 shrink-0">
                        <NotionButton
                            variant="ghost"
                            size="icon"
                            onClick={() => setShowComparison(!showComparison)}
                            className={cn(COARSE_HIT, 'h-8 w-8', showComparison ? 'text-primary bg-primary/10' : 'text-muted-foreground')}
                            aria-pressed={showComparison}
                            aria-label={t('translation:comparison.toggle')}
                        >
                            <Columns size={16} />
                        </NotionButton>
                        <NotionButton
                            variant="ghost"
                            size="icon"
                            onClick={onEditTranslation}
                            disabled={isTranslating}
                            className={cn(COARSE_HIT, 'h-8 w-8 text-muted-foreground')}
                            aria-label={t('translation:target_section.edit')}
                        >
                            <PencilSimple size={16} />
                        </NotionButton>
                        <NotionButton
                            variant="ghost"
                            size="icon"
                            onClick={onSpeak}
                            disabled={isTranslating}
                            className={cn(COARSE_HIT, 'h-8 w-8', isSpeaking ? 'text-primary bg-primary/10' : 'text-muted-foreground')}
                            aria-label={isSpeaking ? t('translation:target_section.stop_listen') : t('translation:target_section.listen')}
                        >
                            <SpeakerHigh size={16} className={isSpeaking ? 'animate-pulse motion-reduce:animate-none' : ''} />
                        </NotionButton>
                        <NotionButton
                            variant="ghost"
                            size="icon"
                            onClick={handleCopy}
                            disabled={isTranslating}
                            className={cn(COARSE_HIT, 'h-8 w-8 text-muted-foreground')}
                            aria-label={t('translation:target_section.copy')}
                        >
                            {copyIcon}
                        </NotionButton>
                        <NotionButton
                            variant="ghost"
                            size="icon"
                            onClick={onExportTranslation}
                            disabled={isTranslating}
                            className={cn(COARSE_HIT, 'h-8 w-8 text-muted-foreground')}
                            aria-label={t('translation:target_section.export')}
                        >
                            <Download size={16} />
                        </NotionButton>
                    </div>
                </div>
            )}

            {/* 内容区（编辑 / 对照 / 默认流式，三态互斥） */}
            <div className="flex-1 min-h-0 flex flex-col relative">
                {isEditingTranslation ? (
                    <div className="flex-1 min-h-0 flex flex-col p-4 ui-rise-in">
                        <Textarea
                            value={editedTranslation}
                            onChange={(e) => setEditedTranslation(e.target.value)}
                            data-translation-scroll="target"
                            className="flex-1 min-h-0 resize-none !bg-transparent !border-0 !shadow-none !rounded-none px-2 py-2 text-base leading-relaxed focus-visible:!ring-0"
                            autoFocus
                        />
                        <div className="flex items-center justify-between mt-3 shrink-0">
                            <span className="text-xs text-muted-foreground tabular-nums">
                                {editedTranslation.length.toLocaleString()} {t('translation:stats.characters')}
                            </span>
                            <div className="flex gap-2">
                                <NotionButton variant="outline" size="sm" onClick={onCancelEdit}>
                                    {t('common:cancel')}
                                </NotionButton>
                                <NotionButton variant="default" size="sm" onClick={onSaveEditedTranslation}>
                                    <CheckCircle size={16} className="mr-2" />
                                    {t('common:save')}
                                </NotionButton>
                            </div>
                        </div>
                    </div>
                ) : showComparison ? (
                    <div className="flex-1 min-h-0 flex flex-col ui-rise-in" ref={setContentWrap}>
                        <ComparisonView
                            sourceText={sourceText}
                            translatedText={translatedText}
                            srcLang={srcLang}
                            tgtLang={tgtLang}
                            isTranslating={isTranslating}
                        />
                    </div>
                ) : (
                    <div className="flex-1 min-h-0 flex flex-col" ref={setContentWrap}>
                        <div className="flex-1 min-h-0 overflow-hidden">
                            <TranslationStreamRenderer
                                content={translatedText}
                                isStreaming={isTranslating}
                                placeholder={t('translation:target_section.placeholder')}
                                showStats={false}
                            />
                        </div>

                        {/* 悬浮状态条：评分 + 字数 */}
                        {translatedText && !isTranslating && (
                            <div className="absolute bottom-4 left-4 right-4 flex items-center justify-between pointer-events-none opacity-0 group-hover/target:opacity-100 [@media(pointer:coarse)]:opacity-100 transition-opacity duration-200">
                                <div data-wb-blur-surface className="pointer-events-auto bg-background/80 backdrop-blur-sm border rounded-full shadow-sm px-1 py-0.5 flex items-center">
                                    {[1, 2, 3, 4, 5].map((rating) => (
                                        <NotionButton
                                            key={rating}
                                            variant="ghost"
                                            size="icon"
                                            onClick={() => onRateTranslation(rating)}
                                            aria-label={t('translation:panel_ux.rate_star', { count: rating })}
                                            className="h-7 w-7 p-1.5 hover:bg-[var(--interactive-hover)] rounded-full"
                                        >
                                            <Star
                                                weight={translationQuality && rating <= translationQuality ? 'fill' : 'regular'}
                                                className={cn(
                                                    'w-3.5 h-3.5 transition-colors',
                                                    translationQuality && rating <= translationQuality
                                                        ? 'text-warning'
                                                        : 'text-muted-foreground hover:text-warning'
                                                )}
                                            />
                                        </NotionButton>
                                    ))}
                                </div>
                                <div data-wb-blur-surface className="bg-background/80 backdrop-blur-sm border rounded-lg px-2 py-1 text-xs text-muted-foreground shadow-sm tabular-nums">
                                    {targetCharCount.toLocaleString()} {t('translation:stats.characters')}
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
});

TargetPanel.displayName = 'TargetPanel';
