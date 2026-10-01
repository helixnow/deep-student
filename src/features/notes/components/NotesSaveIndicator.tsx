import React from 'react';
import { useTranslation } from 'react-i18next';
import { WarningCircle } from '@phosphor-icons/react';
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

/**
 * 顶栏里的安静保存状态：已保存时只是一行淡字（悬停看时间/字数/阅读时长），
 * 只有保存中、未保存、失败、冲突才变得醒目。
 */
export const NotesSaveIndicator: React.FC<NotesSaveIndicatorProps> = ({
    saveStatus,
    lastSaved,
    charCount,
    readOnly = false,
    onRetrySave,
}) => {
    const { t } = useTranslation(['notes', 'common']);
    const label = (() => {
        switch (saveStatus) {
            case 'saving': return t('notes:editor.save_status.saving');
            case 'unsaved': return t('notes:editor.save_status.unsaved');
            case 'failed': return t('notes:editor.save_status.save_failed');
            case 'conflict': return t('notes:editor.save_status.conflict');
            default: return t('notes:editor.save_status.saved');
        }
    })();
    const details = [
        lastSaved ? t('notes:editor.save_status.saved_at', { time: lastSaved.toLocaleTimeString() }) : null,
        typeof charCount === 'number' && charCount > 0 ? t('notes:common.char_count', { count: charCount }) : null,
        typeof charCount === 'number' && charCount > 0
            ? t('notes:editor.stats.reading_value', { defaultValue: '~{{minutes}} min', minutes: estimateReadingMinutes(charCount) })
            : null,
    ].filter(Boolean).join(' · ');
    const alarming = saveStatus === 'failed' || saveStatus === 'conflict';

    return (
        <span
            className={cn(
                'notes-save-indicator inline-flex items-center gap-1 whitespace-nowrap px-1.5 text-xs tabular-nums',
                alarming ? 'text-destructive' : saveStatus === 'saved' ? 'text-muted-foreground/55' : 'text-muted-foreground',
            )}
            data-status={saveStatus}
            title={details || undefined}
            aria-live="polite"
        >
            {alarming && <WarningCircle size={13} weight="bold" aria-hidden="true" />}
            {saveStatus === 'unsaved' && <span className="notes-save-indicator-dot" aria-hidden="true" />}
            <span>{label}</span>
            {saveStatus === 'failed' && !readOnly && onRetrySave && (
                <button
                    type="button"
                    className="underline underline-offset-2 hover:text-destructive/90"
                    onClick={() => { void onRetrySave(); }}
                >
                    {t('notes:editor.save_status.retry')}
                </button>
            )}
        </span>
    );
};
