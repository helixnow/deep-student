import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, CircleNotch, WarningCircle } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { cn } from '@/lib/utils';
import { estimateReadingMinutes } from '../notesUtils';
import type { NotesSaveStatus } from './NotesEditorHeader';

interface NotesSaveIndicatorProps {
    saveStatus: NotesSaveStatus;
    lastSaved: Date | null;
    charCount?: number;
    readOnly?: boolean;
    onRetrySave?: () => void | Promise<void>;
}

const AUTO_SAVED_RECEIPT_MS = 2200;

/**
 * 顶栏里的安静保存状态与阅读元数据：
 * - 未保存：圆点提醒；保存中：轻量转圈；刚完成保存：温和「已自动保存」回执后归于平静；
 * - 宽屏下直接内联展示字数与预计阅读时长（窄分栏由容器查询自动收起，悬停 title 仍可见）。
 */
export const NotesSaveIndicator: React.FC<NotesSaveIndicatorProps> = ({
    saveStatus,
    lastSaved,
    charCount,
    readOnly = false,
    onRetrySave,
}) => {
    const { t } = useTranslation(['notes', 'common', 'translation']);
    const prevStatusRef = useRef<NotesSaveStatus>(saveStatus);
    const [justAutoSaved, setJustAutoSaved] = useState(false);

    useEffect(() => {
        const prev = prevStatusRef.current;
        prevStatusRef.current = saveStatus;
        if (saveStatus === 'saved' && (prev === 'saving' || prev === 'unsaved')) {
            setJustAutoSaved(true);
            const timer = setTimeout(() => {
                setJustAutoSaved(false);
            }, AUTO_SAVED_RECEIPT_MS);
            return () => clearTimeout(timer);
        }
        if (saveStatus !== 'saved') {
            setJustAutoSaved(false);
        }
        return undefined;
    }, [saveStatus]);

    const readingMinutes = typeof charCount === 'number' && charCount > 0
        ? estimateReadingMinutes(charCount)
        : 0;

    const label = (() => {
        switch (saveStatus) {
            case 'saving': return t('notes:editor.save_status.saving');
            case 'unsaved': return t('notes:editor.save_status.unsaved');
            case 'failed': return t('notes:editor.save_status.save_failed');
            case 'conflict': return t('notes:editor.save_status.conflict');
            default:
                return justAutoSaved
                    ? t('notes:editor.save_status.auto_saved')
                    : t('notes:editor.save_status.saved');
        }
    })();

    const details = [
        lastSaved ? t('notes:editor.save_status.saved_at', { time: lastSaved.toLocaleTimeString() }) : null,
        typeof charCount === 'number' && charCount > 0 ? `${t('translation:stats.characters', 'Characters')} ${charCount}` : null,
        readingMinutes > 0
            ? t('notes:editor.stats.reading_value', { defaultValue: '~{{minutes}} min', minutes: readingMinutes })
            : null,
    ].filter(Boolean).join(' · ');
    const alarming = saveStatus === 'failed' || saveStatus === 'conflict';

    return (
        <span
            className={cn(
                'notes-save-indicator inline-flex items-center gap-1 whitespace-nowrap px-1.5 text-xs tabular-nums transition-colors duration-200 motion-reduce:transition-none',
                alarming
                    ? 'text-destructive'
                    : saveStatus === 'saved' && !justAutoSaved
                        ? 'text-muted-foreground/55'
                        : 'text-muted-foreground',
            )}
            data-status={saveStatus}
            data-just-saved={justAutoSaved ? 'true' : undefined}
            title={details || undefined}
            aria-live="polite"
        >
            {alarming && <WarningCircle size={13} weight="bold" aria-hidden="true" />}
            {saveStatus === 'saving' && (
                <CircleNotch size={12} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            )}
            {saveStatus === 'unsaved' && <span className="notes-save-indicator-dot" aria-hidden="true" />}
            {saveStatus === 'saved' && justAutoSaved && (
                <Check
                    size={12}
                    weight="bold"
                    className="shrink-0 text-primary transition-opacity duration-200 motion-reduce:transition-none"
                    aria-hidden="true"
                />
            )}
            <span>{label}</span>
            {!alarming && typeof charCount === 'number' && charCount > 0 && (
                <span
                    className="notes-save-indicator-meta hidden md:inline text-muted-foreground/55"
                    data-testid="notes-reading-meta"
                >
                    {'· '}
                    {t('notes:editor.stats.summary', { count: charCount, minutes: readingMinutes })}
                </span>
            )}
            {saveStatus === 'failed' && !readOnly && onRetrySave && (
                <DsButton
                    variant="ghost"
                    size="sm"
                    className="h-5 px-1.5 text-xs text-destructive underline underline-offset-2 hover:text-destructive/90"
                    onClick={() => { void onRetrySave(); }}
                >
                    {t('notes:editor.save_status.retry')}
                </DsButton>
            )}
        </span>
    );
};
