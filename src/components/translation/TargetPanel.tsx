import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DsButton } from '@/components/ui/DsButton';
import { coarseHitClassFor24, coarseHitClassFor28, coarseHitClassFor32 } from '@/components/ui/coarseHit';
import {
    AppMenu,
    AppMenuContent,
    AppMenuItem,
    AppMenuSeparator,
    AppMenuTrigger,
} from '../ui/app-menu';
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
    CircleNotch,
    CardsThree,
    DotsThree,
} from '@phosphor-icons/react';
import { cn } from '@/utils/cn';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
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
    onCopyResult: () => boolean | void | Promise<boolean | void>;
    onExportTranslation: () => void;
    onSaveAsFlashcard?: () => void | Promise<void>;
    isOutdated?: boolean;
    onRetranslate?: () => void;
    onSaveAsNewVersion?: () => void;
    onKeepCurrentTranslation?: () => void;
}

const COPY_FEEDBACK_MS = 1500;

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
    onSaveAsFlashcard,
    isOutdated = false,
    onRetranslate,
    onSaveAsNewVersion,
    onKeepCurrentTranslation,
}, ref) => {
    const { t } = useTranslation(['translation', 'common']);
    const [showComparison, setShowComparison] = useState(false);

    // 译文统计：面板内部自行计算，不信任外部传入（历史上曾误传原文统计）
    const targetCharCount = translatedText.length;

    // ===== 复制按钮成功态 =====
    const [justCopied, setJustCopied] = useState(false);
    const copyTimerRef = useRef<number | null>(null);
    const markCopied = useCallback(() => {
        setJustCopied(true);
        if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = window.setTimeout(() => {
            setJustCopied(false);
            copyTimerRef.current = null;
        }, COPY_FEEDBACK_MS);
    }, []);
    const handleCopy = useCallback(() => {
        const result = onCopyResult();
        if (result && typeof (result as Promise<unknown>).then === 'function') {
            void (result as Promise<boolean | void>).then((ok) => {
                if (ok !== false) markCopied();
            });
            return;
        }
        if (result !== false) {
            markCopied();
        }
    }, [markCopied, onCopyResult]);

    // ===== 存为生词闪卡（打通查词 → 记忆闭环） =====
    const [savingFlashcard, setSavingFlashcard] = useState(false);
    const [justSavedFlashcard, setJustSavedFlashcard] = useState(false);
    const flashcardTimerRef = useRef<number | null>(null);

    const handleSaveAsFlashcard = useCallback(async () => {
        if (savingFlashcard || isTranslating) return;
        const back = translatedText.trim();
        if (!back) return;
        const front = sourceText.trim() || back;
        setSavingFlashcard(true);
        try {
            if (onSaveAsFlashcard) {
                await onSaveAsFlashcard();
            } else {
                const [{ ankiApiAdapter }, { enqueueAnkiLibraryCard }, { requestFlashcardsDueRefresh }] = await Promise.all([
                    import('@/services/ankiApiAdapter'),
                    import('@/utils/chatApi'),
                    import('@/events/flashcards'),
                ]);
                const deckName = t('translation:target_section.vocab_deck', { defaultValue: '翻译生词本' });
                const tags = ['生词', '翻译', `${srcLang}->${tgtLang}`];
                const response = await ankiApiAdapter.saveAnkiCards({
                    cards: [{ front, back, tags, images: [] }],
                    options: {
                        deck_name: deckName,
                        note_type: 'Basic',
                        enable_images: false,
                        max_cards_per_source: 1,
                        max_cards_per_mistake: 1,
                    },
                });
                const savedId =
                    response.savedIds?.[0] ??
                    response.cardIdMappings?.[0]?.persistedId ??
                    null;
                if (!savedId) {
                    const failure = response.failed?.[0]?.error;
                    throw new Error(
                        failure || t('translation:target_section.save_flashcard_failed', { defaultValue: '保存生词闪卡失败' }),
                    );
                }
                await enqueueAnkiLibraryCard(savedId).catch(() => undefined);
                requestFlashcardsDueRefresh();
            }
            setJustSavedFlashcard(true);
            if (flashcardTimerRef.current !== null) window.clearTimeout(flashcardTimerRef.current);
            flashcardTimerRef.current = window.setTimeout(() => {
                setJustSavedFlashcard(false);
                flashcardTimerRef.current = null;
            }, COPY_FEEDBACK_MS);
            showGlobalNotification(
                'success',
                t('translation:target_section.saved_as_flashcard', { defaultValue: '已存为生词闪卡，已加入记忆队列' }),
            );
        } catch (error: unknown) {
            showGlobalNotification(
                'error',
                getErrorMessage(error) || t('translation:target_section.save_flashcard_failed', { defaultValue: '保存生词闪卡失败' }),
            );
        } finally {
            setSavingFlashcard(false);
        }
    }, [savingFlashcard, isTranslating, translatedText, sourceText, onSaveAsFlashcard, t, srcLang, tgtLang]);

    useEffect(() => () => {
        if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
        if (flashcardTimerRef.current !== null) window.clearTimeout(flashcardTimerRef.current);
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

    const isMac =
        typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent || '');
    const translateShortcut = isMac ? '⌘ + Enter' : 'Ctrl + Enter';
    const hasSourceText = sourceText.trim().length > 0;

    return (
        <div className="flex flex-col h-full min-h-0 flex-1 basis-1/2 min-w-0 bg-foreground/[0.015] relative group/target">
            {/* 桌面右上轻量悬浮动作组（消除独立二级顶栏横线，空态仅保留对照切换） */}
            <div className="hidden md:flex items-center gap-0.5 absolute top-2.5 right-3 z-10 rounded-full border border-border/35 bg-background px-1.5 py-0.5 shadow-xs">
                    {/* 对照切换（tooltip 带用途说明，帮助首次用户理解该视图） */}
                    <CommonTooltip content={`${t('translation:comparison.toggle')} · ${t('translation:tabs.comparison_description')}`}>
                        <DsButton
                            variant="ghost"
                            size="icon"
                            onClick={() => setShowComparison(!showComparison)}
                            disabled={isEditingTranslation}
                            aria-pressed={showComparison}
                            aria-label={t('translation:comparison.toggle')}
                            className={cn(
                                coarseHitClassFor28,
                                'h-7 w-7 [@media(pointer:coarse)]:!min-h-0 [@media(pointer:coarse)]:!min-w-0 transition-colors',
                                showComparison
                                    ? 'text-primary bg-primary/10'
                                    : 'text-muted-foreground hover:text-foreground'
                            )}
                        >
                            <Columns size={15} />
                        </DsButton>
                    </CommonTooltip>

                    {/* 同步滚动（lg+ 由顶部工具栏承载，这里只补足中等宽度） */}
                    <div className="flex lg:hidden items-center gap-1.5 px-1.5 py-0.5 rounded-md hover:bg-[var(--interactive-hover)] transition-colors">
                        <Switch
                            id="target-sync-scroll"
                            aria-label={t('translation:sync_scroll')}
                            checked={isSyncScroll}
                            onCheckedChange={setIsSyncScroll}
                            className="data-[state=checked]:bg-primary"
                        />
                        <Label htmlFor="target-sync-scroll" className="flex items-center text-xs font-medium text-muted-foreground cursor-pointer whitespace-nowrap">
                            {t('translation:sync_scroll')}
                        </Label>
                    </div>

                    {translatedText && (
                        <>
                            <div className="w-px h-3.5 bg-border/35 mx-0.5" />
                            <CommonTooltip content={t('translation:target_section.edit')}>
                                <DsButton
                                    variant="ghost"
                                    size="icon"
                                    onClick={onEditTranslation}
                                    disabled={isEditingTranslation || isTranslating}
                                    aria-label={t('translation:target_section.edit')}
                                    className={cn(coarseHitClassFor28, 'w-7 h-7 [@media(pointer:coarse)]:!min-h-0 [@media(pointer:coarse)]:!min-w-0 text-muted-foreground hover:text-foreground')}
                                >
                                    <PencilSimple size={15} />
                                </DsButton>
                            </CommonTooltip>
                            <CommonTooltip content={isSpeaking ? t('translation:target_section.stop_listen') : t('translation:target_section.listen')}>
                                <DsButton
                                    variant="ghost"
                                    size="icon"
                                    onClick={onSpeak}
                                    disabled={!translatedText || isEditingTranslation || isTranslating}
                                    aria-label={isSpeaking ? t('translation:target_section.stop_listen') : t('translation:target_section.listen')}
                                    className={cn(
                                        coarseHitClassFor28,
                                        'h-7 w-7 [@media(pointer:coarse)]:!min-h-0 [@media(pointer:coarse)]:!min-w-0 transition-colors',
                                        isSpeaking ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground'
                                    )}
                                >
                                    <SpeakerHigh size={15} />
                                </DsButton>
                            </CommonTooltip>
                            <CommonTooltip content={justCopied ? t('translation:target_section.copied') : t('translation:target_section.copy')}>
                                <DsButton
                                    variant="ghost"
                                    size={justCopied ? 'sm' : 'icon'}
                                    onClick={handleCopy}
                                    disabled={isTranslating}
                                    aria-label={justCopied ? t('translation:target_section.copied') : t('translation:target_section.copy')}
                                    data-testid="translation-copy-btn"
                                    className={cn(
                                        coarseHitClassFor28,
                                        'h-7 [@media(pointer:coarse)]:!min-h-0 [@media(pointer:coarse)]:!min-w-0 transition-all duration-150 motion-reduce:transition-none active:scale-95 motion-reduce:active:scale-100',
                                        justCopied
                                            ? 'w-auto px-2 gap-1 bg-success/10 text-success hover:bg-success/15 hover:text-success'
                                            : 'w-7 text-muted-foreground hover:text-foreground'
                                    )}
                                >
                                    {copyIcon}
                                    {justCopied && (
                                        <span className="text-2xs font-medium">{t('translation:target_section.copied_short')}</span>
                                    )}
                                </DsButton>
                            </CommonTooltip>
                            <CommonTooltip content={justSavedFlashcard ? t('translation:target_section.saved_as_flashcard_short', { defaultValue: '已存闪卡' }) : t('translation:target_section.save_as_flashcard', { defaultValue: '存为生词闪卡' })}>
                                <DsButton
                                    variant="ghost"
                                    size={justSavedFlashcard ? 'sm' : 'icon'}
                                    onClick={() => void handleSaveAsFlashcard()}
                                    disabled={isTranslating || savingFlashcard}
                                    aria-label={t('translation:target_section.save_as_flashcard', { defaultValue: '存为生词闪卡' })}
                                    data-testid="translation-save-flashcard-btn"
                                    className={cn(
                                        coarseHitClassFor28,
                                        'h-7 [@media(pointer:coarse)]:!min-h-0 [@media(pointer:coarse)]:!min-w-0 transition-all duration-150 motion-reduce:transition-none active:scale-95 motion-reduce:active:scale-100',
                                        justSavedFlashcard
                                            ? 'w-auto px-2 gap-1 bg-success/10 text-success hover:bg-success/15 hover:text-success'
                                            : 'w-7 text-muted-foreground hover:text-foreground'
                                    )}
                                >
                                    {savingFlashcard ? (
                                        <CircleNotch size={15} className="animate-spin motion-reduce:animate-none" />
                                    ) : justSavedFlashcard ? (
                                        <Check size={15} className="text-success" />
                                    ) : (
                                        <CardsThree size={15} />
                                    )}
                                    {justSavedFlashcard && (
                                        <span className="text-2xs font-medium">{t('translation:target_section.saved_as_flashcard_short', { defaultValue: '已存闪卡' })}</span>
                                    )}
                                </DsButton>
                            </CommonTooltip>
                            <CommonTooltip content={t('translation:target_section.export')}>
                                <DsButton
                                    variant="ghost"
                                    size="icon"
                                    onClick={onExportTranslation}
                                    disabled={isTranslating}
                                    aria-label={t('translation:target_section.export')}
                                    className={cn(coarseHitClassFor28, 'w-7 h-7 [@media(pointer:coarse)]:!min-h-0 [@media(pointer:coarse)]:!min-w-0 text-muted-foreground hover:text-foreground')}
                                >
                                    <Download size={15} />
                                </DsButton>
                            </CommonTooltip>
                        </>
                    )}
            </div>

            {/* 移动端操作栏：保留高频「复制」，其余低频动作收进「更多」AppMenu 避免 7 钮拥挤 */}
            {translatedText && !isEditingTranslation && (
                <div className="md:hidden flex items-center justify-between px-3 h-10 border-b border-border/35 bg-background shrink-0">
                    <span className="text-xs text-muted-foreground flex items-center gap-1 min-w-0 truncate">
                        <Translate size={13} className="shrink-0" />
                        {t('translation:target_section.title')}
                        <span className="font-mono tabular-nums text-muted-foreground/60">· {targetCharCount.toLocaleString()}</span>
                    </span>
                    <div className="flex items-center gap-0.5 shrink-0">
                        <DsButton
                            variant="ghost"
                            size="icon"
                            onClick={handleCopy}
                            disabled={isTranslating}
                            className={cn(coarseHitClassFor32, 'h-8 w-8 [@media(pointer:coarse)]:!min-h-0 [@media(pointer:coarse)]:!min-w-0 text-muted-foreground')}
                            aria-label={t('translation:target_section.copy')}
                        >
                            {copyIcon}
                        </DsButton>
                        <AppMenu>
                            <AppMenuTrigger asChild>
                                <DsButton
                                    variant="ghost"
                                    size="icon"
                                    data-testid="translation-target-more-btn"
                                    className={cn(coarseHitClassFor32, 'h-8 w-8 [@media(pointer:coarse)]:!min-h-0 [@media(pointer:coarse)]:!min-w-0 text-muted-foreground')}
                                    aria-label={t('common:more', { defaultValue: '更多' })}
                                >
                                    <DotsThree size={18} weight="bold" aria-hidden="true" />
                                </DsButton>
                            </AppMenuTrigger>
                            <AppMenuContent align="end" width={200}>
                                <AppMenuItem
                                    icon={<Columns size={15} aria-hidden="true" />}
                                    checked={showComparison}
                                    onClick={() => setShowComparison(!showComparison)}
                                >
                                    {t('translation:comparison.toggle')}
                                </AppMenuItem>
                                <AppMenuItem
                                    icon={<PencilSimple size={15} aria-hidden="true" />}
                                    disabled={isTranslating}
                                    onClick={onEditTranslation}
                                >
                                    {t('translation:target_section.edit')}
                                </AppMenuItem>
                                <AppMenuItem
                                    icon={<SpeakerHigh size={15} aria-hidden="true" />}
                                    disabled={isTranslating}
                                    onClick={onSpeak}
                                >
                                    {isSpeaking ? t('translation:target_section.stop_listen') : t('translation:target_section.listen')}
                                </AppMenuItem>
                                <AppMenuSeparator />
                                <AppMenuItem
                                    icon={
                                        savingFlashcard ? (
                                            <CircleNotch size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                                        ) : justSavedFlashcard ? (
                                            <Check size={15} className="text-success" aria-hidden="true" />
                                        ) : (
                                            <CardsThree size={15} aria-hidden="true" />
                                        )
                                    }
                                    disabled={isTranslating || savingFlashcard}
                                    data-testid="translation-save-flashcard-mobile-btn"
                                    onClick={() => void handleSaveAsFlashcard()}
                                >
                                    {t('translation:target_section.save_as_flashcard', { defaultValue: '存为生词闪卡' })}
                                </AppMenuItem>
                                <AppMenuItem
                                    icon={<Download size={15} aria-hidden="true" />}
                                    disabled={isTranslating}
                                    onClick={onExportTranslation}
                                >
                                    {t('translation:target_section.export')}
                                </AppMenuItem>
                            </AppMenuContent>
                        </AppMenu>
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
                                <DsButton variant="outline" size="sm" onClick={onCancelEdit}>
                                    {t('common:cancel')}
                                </DsButton>
                                <DsButton variant="default" size="sm" onClick={onSaveEditedTranslation}>
                                    <CheckCircle size={16} className="mr-2" />
                                    {t('common:save')}
                                </DsButton>
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
                    <div className="flex-1 min-h-0 flex flex-col relative" ref={setContentWrap}>
                        {/* 译文过期提示（原文/设置已修改）：提供非破坏性选择，避免单一 CTA 直接覆盖当前完成稿 */}
                        {isOutdated && !isTranslating && translatedText && (
                            <div
                                data-testid="translation-outdated-banner"
                                className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 bg-warning/10 border-b border-warning/20 text-xs text-warning shrink-0"
                            >
                                <span className="truncate">{t('translation:workbench_ui.outdated_hint')}</span>
                                <div className="flex flex-wrap items-center gap-1 shrink-0">
                                    {onSaveAsNewVersion && (
                                        <DsButton
                                            variant="ghost"
                                            size="sm"
                                            data-testid="translation-outdated-save-new-version-btn"
                                            onClick={onSaveAsNewVersion}
                                            className={cn(coarseHitClassFor24, '!h-6 [@media(pointer:coarse)]:!min-h-0 px-2 text-xs font-medium text-warning hover:bg-warning/15 shrink-0')}
                                        >
                                            {t('translation:workbench_ui.save_as_new_version', { defaultValue: '另存新版本' })}
                                        </DsButton>
                                    )}
                                    {onRetranslate && (
                                        <DsButton
                                            variant="ghost"
                                            size="sm"
                                            data-testid="translation-outdated-retranslate-btn"
                                            onClick={onRetranslate}
                                            className={cn(coarseHitClassFor24, '!h-6 [@media(pointer:coarse)]:!min-h-0 px-2 text-xs text-warning hover:bg-warning/15 shrink-0')}
                                        >
                                            {t('translation:workbench_ui.retranslate_now')}
                                        </DsButton>
                                    )}
                                    {onKeepCurrentTranslation && (
                                        <DsButton
                                            variant="ghost"
                                            size="sm"
                                            data-testid="translation-outdated-keep-current-btn"
                                            onClick={onKeepCurrentTranslation}
                                            className={cn(coarseHitClassFor24, '!h-6 [@media(pointer:coarse)]:!min-h-0 px-2 text-xs text-muted-foreground hover:bg-warning/10 shrink-0')}
                                        >
                                            {t('translation:workbench_ui.keep_current_translation', { defaultValue: '保留当前译文' })}
                                        </DsButton>
                                    )}
                                </div>
                            </div>
                        )}
                        {/* 流式翻译实时状态胶囊 */}
                        {isTranslating && (
                            <div
                                data-testid="translation-streaming-pill"
                                role="status"
                                aria-live="polite"
                                className="pointer-events-none absolute top-3 left-4 z-10 inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-card px-2.5 py-1 text-2xs font-medium text-primary shadow-xs"
                            >
                                <CircleNotch size={12} className="animate-spin motion-reduce:animate-none shrink-0" aria-hidden="true" />
                                <span className="tabular-nums">
                                    {targetCharCount === 0
                                        ? t('translation:target_section.streaming_preparing')
                                        : t('translation:target_section.streaming_live', { count: targetCharCount })}
                                </span>
                            </div>
                        )}

                        <div className="flex-1 min-h-0 overflow-hidden">
                            <TranslationStreamRenderer
                                content={translatedText}
                                isStreaming={isTranslating}
                                placeholder={t('translation:target_section.placeholder')}
                                showStats={false}
                            />
                        </div>

                        {/* 空态学习者引导副提示：区分尚未输入原文与原文已就绪可快捷键翻译 */}
                        {!translatedText && !isTranslating && (
                            <div
                                data-testid="translation-empty-hint"
                                className="pointer-events-none absolute inset-x-4 bottom-5 flex justify-center"
                            >
                                <span className="rounded-full border border-border/35 bg-card px-3 py-1 text-2xs text-muted-foreground/80">
                                    {hasSourceText
                                        ? t('translation:target_section.ready_to_translate', { shortcut: translateShortcut })
                                        : t('translation:target_section.empty_subhint')}
                                </span>
                            </div>
                        )}

                        {/* 悬浮状态条：评分 + 字数 */}
                        {translatedText && !isTranslating && (
                            <div className="absolute bottom-4 left-4 right-4 flex items-center justify-between pointer-events-none opacity-80 group-hover/target:opacity-100 focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100 transition-opacity duration-200">
                                <div className="pointer-events-auto bg-card border border-border/35 rounded-full shadow-sm px-1 py-0.5 flex items-center">
                                    {[1, 2, 3, 4, 5].map((rating) => {
                                        const isSelected = Boolean(translationQuality && rating <= translationQuality);
                                        return (
                                            <DsButton
                                                key={rating}
                                                variant="ghost"
                                                size="icon"
                                                onClick={() => onRateTranslation(rating)}
                                                aria-pressed={isSelected}
                                                aria-label={t('translation:panel_ux.rate_star', { count: rating })}
                                                className={cn(
                                                    coarseHitClassFor28,
                                                    'h-7 w-7 [@media(pointer:coarse)]:!min-h-0 [@media(pointer:coarse)]:!min-w-0 p-1.5 hover:bg-[var(--interactive-hover)] rounded-full',
                                                )}
                                            >
                                                <Star
                                                    weight={isSelected ? 'fill' : 'regular'}
                                                    className={cn(
                                                        'w-3.5 h-3.5 transition-colors',
                                                        isSelected
                                                            ? 'text-warning'
                                                            : 'text-muted-foreground hover:text-warning'
                                                    )}
                                                />
                                            </DsButton>
                                        );
                                    })}
                                </div>
                                <div className="bg-card border border-border/35 rounded-full px-2.5 py-1 text-xs text-muted-foreground shadow-sm font-mono tabular-nums">
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
