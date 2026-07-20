import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DsButton } from '@/components/ui/DsButton';
import { Textarea } from '../ui/shad/Textarea';
import { CommonTooltip } from '../shared/CommonTooltip';
import { FileArrowUp, Lightning, TextAa, Trash, X } from '@phosphor-icons/react';
import { cn } from '@/utils/cn';
import UnifiedDragDropZone, { FILE_TYPES } from '../shared/UnifiedDragDropZone';

interface SourcePanelProps {
    sourceText: string;
    setSourceText: (text: string) => void;
    sourceMaxChars?: number;
    isSourceOverLimit?: boolean;
    isTranslating: boolean;
    onFilesDropped: (files: File[]) => void;
    onClear: () => void;
    onTranslate: () => void;
    onCancelTranslation: () => void;
    sourceCharCount: number;
    /** 挂载时是否自动聚焦输入框（触屏设备自动跳过，避免弹出键盘） */
    autoFocus?: boolean;
}

const isMacLike = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
const TRANSLATE_SHORTCUT = isMacLike ? '⌘ + Enter' : 'Ctrl + Enter';

const PASTE_HINT_DURATION_MS = 4000;
const CLEAR_CONFIRM_TIMEOUT_MS = 4000;

const isCoarsePointer = () =>
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches;

/**
 * 原文输入面板
 *
 * 语向选择/互换已上移到 TranslationMain 顶部工具栏（DeepL 式居中布局），
 * 本面板专注输入体验：拖拽上传、字数统计、内联清空确认、粘贴即翻提示。
 * 滚动契约：textarea 挂 data-translation-scroll="source"，供同步滚动识别。
 */
export const SourcePanel = React.forwardRef<HTMLTextAreaElement, SourcePanelProps>(({
    sourceText,
    setSourceText,
    sourceMaxChars,
    isSourceOverLimit,
    isTranslating,
    onFilesDropped,
    onClear,
    onTranslate,
    onCancelTranslation,
    sourceCharCount,
    autoFocus = false,
}, ref) => {
    const { t } = useTranslation(['translation', 'common']);

    const isNearLimit = Boolean(
        sourceMaxChars && !isSourceOverLimit && sourceCharCount > sourceMaxChars * 0.9
    );

    // ===== 自动聚焦（合并转发 ref，触屏跳过避免键盘弹出） =====
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const setTextareaRef = useCallback((node: HTMLTextAreaElement | null) => {
        textareaRef.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) (ref as React.MutableRefObject<HTMLTextAreaElement | null>).current = node;
    }, [ref]);

    useEffect(() => {
        if (!autoFocus || isCoarsePointer()) return;
        const el = textareaRef.current;
        if (!el || document.activeElement === el) return;
        el.focus({ preventScroll: true });
        const end = el.value.length;
        try {
            el.setSelectionRange(end, end);
        } catch {
            // 某些 webview 对 setSelectionRange 抛错，忽略即可
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoFocus]);

    // ===== 内联清空确认（替代模态确认框） =====
    const [confirmingClear, setConfirmingClear] = useState(false);
    const confirmTimerRef = useRef<number | null>(null);

    const dismissClearConfirm = useCallback(() => {
        setConfirmingClear(false);
        if (confirmTimerRef.current !== null) {
            window.clearTimeout(confirmTimerRef.current);
            confirmTimerRef.current = null;
        }
    }, []);

    const requestClear = useCallback(() => {
        setConfirmingClear(true);
        if (confirmTimerRef.current !== null) window.clearTimeout(confirmTimerRef.current);
        confirmTimerRef.current = window.setTimeout(() => {
            setConfirmingClear(false);
            confirmTimerRef.current = null;
        }, CLEAR_CONFIRM_TIMEOUT_MS);
    }, []);

    const confirmClear = useCallback(() => {
        dismissClearConfirm();
        onClear();
    }, [dismissClearConfirm, onClear]);

    // ===== 粘贴即翻提示 =====
    const [showPasteHint, setShowPasteHint] = useState(false);
    const pasteTimerRef = useRef<number | null>(null);

    const handlePaste = useCallback(() => {
        setShowPasteHint(true);
        if (pasteTimerRef.current !== null) window.clearTimeout(pasteTimerRef.current);
        pasteTimerRef.current = window.setTimeout(() => {
            setShowPasteHint(false);
            pasteTimerRef.current = null;
        }, PASTE_HINT_DURATION_MS);
    }, []);

    useEffect(() => {
        if (isTranslating) setShowPasteHint(false);
    }, [isTranslating]);

    useEffect(() => () => {
        if (confirmTimerRef.current !== null) window.clearTimeout(confirmTimerRef.current);
        if (pasteTimerRef.current !== null) window.clearTimeout(pasteTimerRef.current);
    }, []);

    // ===== 空状态：示例快捷入口 =====
    const sampleTexts = [
        t('translation:workbench_core.sample_en'),
        t('translation:workbench_core.sample_zh'),
    ];

    const handleSampleClick = useCallback((sample: string) => {
        setSourceText(sample);
        const el = textareaRef.current;
        if (el && !isCoarsePointer()) {
            el.focus({ preventScroll: true });
        }
    }, [setSourceText]);

    const charCounter = (
        <span
            className={cn(
                'text-xs tabular-nums whitespace-nowrap transition-colors',
                isSourceOverLimit
                    ? 'text-destructive font-medium'
                    : isNearLimit
                        ? 'text-warning'
                        : 'text-muted-foreground'
            )}
            title={isNearLimit || isSourceOverLimit ? t('translation:panel_ux.near_limit') : undefined}
        >
            {sourceCharCount.toLocaleString()}
            {sourceMaxChars ? ` / ${sourceMaxChars.toLocaleString()}` : ''}
        </span>
    );

    const clearControl = confirmingClear ? (
        <div
            className="flex items-center gap-1 rounded-md bg-destructive/10 pl-2 pr-0.5 py-0.5 text-xs text-destructive"
            role="alertdialog"
            aria-label={t('translation:panel_ux.clear_confirm')}
        >
            <span className="whitespace-nowrap">{t('translation:panel_ux.clear_confirm')}</span>
            <DsButton
                variant="ghost"
                size="sm"
                onClick={confirmClear}
                className="h-6 px-1.5 text-destructive hover:bg-destructive/15 font-medium"
            >
                {t('translation:actions.clear')}
            </DsButton>
            <DsButton
                variant="ghost"
                size="icon"
                onClick={dismissClearConfirm}
                className="h-6 w-6 text-destructive/70 hover:text-destructive"
                aria-label={t('common:cancel')}
            >
                <X size={12} />
            </DsButton>
        </div>
    ) : (
        <CommonTooltip content={t('translation:actions.clear')}>
            <DsButton
                variant="ghost"
                size="icon"
                onClick={requestClear}
                disabled={!sourceText}
                className="h-7 w-7 text-muted-foreground/60 hover:text-destructive"
                aria-label={t('translation:actions.clear')}
            >
                <Trash size={14} />
            </DsButton>
        </CommonTooltip>
    );

    return (
        <div className="flex flex-col h-full min-h-0 flex-1 basis-1/2 min-w-0 border-b lg:border-b-0 lg:border-r relative group/source">
            {/* 桌面工具栏：标题 + 常驻字数 + 清空 */}
            <div data-wb-blur-surface className="hidden sm:flex items-center justify-between px-4 h-10 border-b border-border/50 bg-background/50 backdrop-blur z-10 shrink-0">
                <span className="text-sm text-foreground/70 flex items-center gap-1.5 min-w-0 truncate">
                    <TextAa size={14} className="shrink-0 text-muted-foreground" />
                    {t('translation:source_section.title')}
                </span>
                <div className="flex items-center gap-2 shrink-0">
                    {charCounter}
                    {clearControl}
                </div>
            </div>

            {/* 移动端工具栏：字数 + 清空 + 翻译/取消 */}
            <div className="sm:hidden flex items-center justify-between px-3 h-10 border-b border-border/50 bg-background/50 shrink-0">
                <span className="text-xs text-muted-foreground flex items-center gap-1 min-w-0 truncate">
                    <TextAa size={13} className="shrink-0" />
                    {charCounter}
                </span>
                <div className="flex items-center gap-0.5 shrink-0">
                    {sourceText && !isTranslating && clearControl}
                    {isTranslating ? (
                        <DsButton
                            variant="ghost"
                            size="sm"
                            onClick={onCancelTranslation}
                            className="h-8 px-2 text-muted-foreground"
                        >
                            <X size={14} className="mr-1" />
                            {t('common:cancel')}
                        </DsButton>
                    ) : (
                        <DsButton
                            variant="ghost"
                            size="sm"
                            onClick={onTranslate}
                            disabled={!sourceText.trim()}
                            className="h-8 px-2 text-primary font-medium"
                        >
                            {t('translation:actions.translate')}
                        </DsButton>
                    )}
                </div>
            </div>

            {/* 输入区 */}
            <div className="flex-1 min-h-0 flex flex-col relative overflow-hidden">
                <UnifiedDragDropZone
                    zoneId="translate-upload"
                    onFilesDropped={onFilesDropped}
                    acceptedFileTypes={[FILE_TYPES.IMAGE, FILE_TYPES.DOCUMENT]}
                    maxFiles={1}
                    maxFileSize={50 * 1024 * 1024}
                    className="flex-1 min-h-0 flex flex-col"
                >
                    <Textarea
                        ref={setTextareaRef}
                        value={sourceText}
                        onChange={(e) => setSourceText(e.target.value)}
                        onPaste={handlePaste}
                        placeholder={t('translation:source_section.placeholder')}
                        maxLength={sourceMaxChars}
                        data-translation-scroll="source"
                        aria-label={t('translation:source_section.title')}
                        className="flex-1 min-h-0 resize-none px-4 pt-5 pb-10 text-base leading-relaxed !border-0 !shadow-none !rounded-none !bg-transparent focus:!ring-0 focus:!ring-offset-0 focus-visible:!ring-0 focus-visible:!ring-offset-0 focus:!outline-none focus-visible:!outline-none selection:bg-primary/20"
                    />
                </UnifiedDragDropZone>

                {/* 空状态引导：示例快捷入口 + 拖拽提示（不拦截输入区点击） */}
                {!sourceText && !isTranslating && (
                    <div className="pointer-events-none absolute inset-x-4 bottom-4 flex flex-col gap-2 ui-fade-in">
                        <span className="flex items-center gap-1.5 text-xs text-muted-foreground/70 select-none">
                            <Lightning size={12} className="shrink-0" />
                            {t('translation:workbench_core.samples_label')}
                        </span>
                        <div className="flex flex-wrap gap-1.5">
                            {sampleTexts.map((sample) => (
                                <button
                                    key={sample}
                                    type="button"
                                    onClick={() => handleSampleClick(sample)}
                                    className="pointer-events-auto max-w-full truncate rounded-full border border-border/70 bg-background/80 px-3 py-1 text-xs text-muted-foreground transition-colors duration-150 hover:border-border hover:bg-[var(--interactive-hover)] hover:text-foreground active:scale-[0.98] motion-reduce:transition-none"
                                >
                                    {sample}
                                </button>
                            ))}
                        </div>
                        <span className="flex items-center gap-1.5 text-xs text-muted-foreground/50 select-none">
                            <FileArrowUp size={12} className="shrink-0" />
                            {t('translation:workbench_core.drop_hint_inline')}
                        </span>
                    </div>
                )}

                {/* 粘贴即翻提示 */}
                {showPasteHint && !isTranslating && sourceText.trim() && (
                    <div data-wb-blur-surface className="pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2 rounded-full border bg-background/90 backdrop-blur px-3 py-1 text-xs text-muted-foreground shadow-sm whitespace-nowrap ui-fade-in">
                        {t('translation:panel_ux.paste_hint', { shortcut: TRANSLATE_SHORTCUT })}
                    </div>
                )}
            </div>

            {/* 桌面主操作栏 */}
            <div data-wb-blur-surface className="hidden sm:flex p-3 border-t bg-background/50 backdrop-blur items-center justify-end shrink-0">
                {isTranslating ? (
                    <DsButton
                        variant="default"
                        onClick={onCancelTranslation}
                        className="min-w-[120px]"
                    >
                        <X size={14} className="mr-2" />
                        {t('common:cancel')}
                    </DsButton>
                ) : (
                    <DsButton
                        variant="primary"
                        onClick={onTranslate}
                        disabled={!sourceText.trim()}
                        className="min-w-[120px]"
                        title={`${t('translation:actions.translate')} · ${TRANSLATE_SHORTCUT}`}
                    >
                        {t('translation:actions.translate')}
                        <kbd className="ml-2 hidden md:inline text-[10px] font-mono opacity-60 tracking-tight">
                            {isMacLike ? '⌘↵' : 'Ctrl↵'}
                        </kbd>
                    </DsButton>
                )}
            </div>
        </div>
    );
});

SourcePanel.displayName = 'SourcePanel';
