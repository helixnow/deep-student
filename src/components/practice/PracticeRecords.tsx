import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowClockwise, Play, Trash, ListChecks } from '@phosphor-icons/react';
import { practiceApi, type PracticeSummary } from '@/api/practiceApi';
import { DsButton } from '@/components/ui/DsButton';
import { getErrorMessage } from '@/utils/errorUtils';

interface Props {
  scopeId: string;
  onOpen: (id: string, submitted: boolean) => void;
  paperId?: string;
  readOnly?: boolean;
}
export default function PracticeRecords({ scopeId, onOpen, paperId, readOnly }: Props) {
  const { t } = useTranslation('practice');
  const [drafts, setDrafts] = useState<PracticeSummary[]>([]);
  const [attempts, setAttempts] = useState<PracticeSummary[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([practiceApi.list(scopeId, false), practiceApi.list(scopeId, true)])
      .then(([drafts, attempts]) => {
        if (!cancelled) {
          setDrafts(readOnly ? [] : drafts.filter((d) => !paperId || d.paper_id === paperId));
          setAttempts(attempts.filter((a) => !paperId || a.paper_id === paperId));
          setError(null);
        }
      })
      .catch((error) => {
        if (!cancelled) setError(getErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [scopeId, paperId, revision, readOnly]);
  const remove = async (row: PracticeSummary, submitted: boolean) => {
    try {
      await practiceApi.remove(row.id, submitted);
      setDeleteId(null);
      setRevision((r) => r + 1);
    } catch (error) {
      setError(getErrorMessage(error));
    }
  };
  const row = (record: PracticeSummary, submitted: boolean) => (
    <div
      key={record.id}
      className="flex flex-wrap items-center gap-2 border-b border-border/50 py-2 text-sm"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{record.title}</p>
        <p className="text-xs text-muted-foreground">
          {new Date(record.updated_at).toLocaleString()} ·{' '}
          {t('batch.progress', { answered: record.answered_count, total: record.question_count })}
          {submitted &&
            ` · ${t('batch.correctCount', { count: record.correct_count })} · ${t('batch.pendingCount', { count: record.pending_count })}`}
        </p>
      </div>
      <DsButton variant="outline" size="sm" onClick={() => onOpen(record.id, submitted)}>
        {submitted ? <ListChecks size={16} /> : <Play size={16} />}
        {t(submitted ? 'batch.viewResult' : 'batch.continue')}
      </DsButton>
      {!readOnly && <DsButton
        variant="ghost"
        size="icon"
        iconOnly
        title={t('common:delete')}
        aria-label={t('common:delete')}
        onClick={() => setDeleteId(record.id)}
      >
        <Trash size={16} />
      </DsButton>}
      {deleteId === record.id && (
        <div className="flex w-full items-center justify-end gap-2">
          <span className="mr-auto text-xs text-muted-foreground">{t('batch.deleteRecord')}</span>
          <DsButton variant="ghost" size="sm" onClick={() => setDeleteId(null)}>
            {t('common:cancel')}
          </DsButton>
          <DsButton variant="danger" size="sm" onClick={() => void remove(record, submitted)}>
            {t('common:delete')}
          </DsButton>
        </div>
      )}
    </div>
  );
  return (
    <section className="space-y-2">
      {error && (
        <div className="flex items-center gap-2 text-sm text-destructive" role="alert">
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            aria-label={t('common:actions.retry')}
            onClick={() => setRevision((r) => r + 1)}
          >
            <ArrowClockwise size={16} />
          </DsButton>
        </div>
      )}
      {!!drafts.length && (
        <>
          <h3 className="text-sm font-medium">{t('batch.continue')}</h3>
          {drafts.map((d) => row(d, false))}
        </>
      )}
      {!!attempts.length && (
        <>
          <DsButton
            variant="ghost"
            size="sm"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((v) => !v)}
          >
            <ListChecks size={16} />
            {t('batch.history')} ({attempts.length})
          </DsButton>
          {historyOpen && attempts.map((a) => row(a, true))}
        </>
      )}
    </section>
  );
}
