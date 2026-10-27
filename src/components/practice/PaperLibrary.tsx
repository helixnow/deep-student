import React, { lazy, Suspense, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FileText,
  Play,
  Download,
  PencilSimple,
  Trash,
  Plus,
  ArrowLeft,
  CircleNotch,
} from '@phosphor-icons/react';
import { practiceApi, type PracticeSummary } from '@/api/practiceApi';
import type { GeneratedPaper } from '@/stores/questionBankStore';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { MarkdownRenderer } from '@/features/chat/components/renderers';
import { QuestionMaterialView } from '@/components/QuestionMaterialView';
import { getErrorMessage } from '@/utils/errorUtils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import PracticeRecords from './PracticeRecords';

const PaperGenerator = lazy(() => import('./PaperGenerator'));
interface Props {
  examId: string;
  readOnly?: boolean;
  onStartPaper: (paper: GeneratedPaper) => void;
  onOpenPractice: (id: string, submitted: boolean) => void;
}
export default function PaperLibrary({ examId, readOnly, onStartPaper, onOpenPractice }: Props) {
  const { t } = useTranslation('practice');
  const [papers, setPapers] = useState<GeneratedPaper[]>([]);
  const [records, setRecords] = useState<PracticeSummary[]>([]);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<GeneratedPaper | null>(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [format, setFormat] = useState<'pdf' | 'word' | 'markdown'>('pdf');
  const [answers, setAnswers] = useState(true);
  const [explanations, setExplanations] = useState(true);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([practiceApi.papers(examId), practiceApi.list(examId, false), practiceApi.list(examId, true)])
      .then(([papers, drafts, attempts]) => {
        if (!cancelled) {
          setPapers(papers);
          setRecords([...drafts, ...attempts]);
          setError(null);
        }
      })
      .catch((error) => {
        if (!cancelled) setError(getErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [examId, revision]);
  const exportPaper = async (paper: GeneratedPaper) => {
    setBusy(true);
    try {
      const { exportPaperToFile } = await import('./paperExport');
      await exportPaperToFile(paper, {
        format,
        includeAnswers: answers,
        includeExplanations: explanations,
      });
    } catch (error) {
      showGlobalNotification('error', getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <CustomScrollArea className="h-full" viewportClassName="space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        {(creating || selected) && (
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            aria-label={t('common:back')}
            onClick={() => {
              setCreating(false);
              setSelected(null);
            }}
          >
            <ArrowLeft size={18} />
          </DsButton>
        )}
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium">
          {selected?.title ?? t('batch.papers')}
        </h3>
        {!readOnly && !creating && (
          <DsButton size="sm" variant="outline" onClick={() => setCreating(true)}>
            <Plus size={16} />
            {t('paper.generate')}
          </DsButton>
        )}
      </div>
      {error && (
        <p role="alert" className="break-words text-sm text-destructive">
          {error}
        </p>
      )}
      {creating ? (
        <Suspense fallback={<CircleNotch className="animate-spin" />}>
          <PaperGenerator
            examId={examId}
            onGenerate={(paper) => {
              setSelected(paper);
              setCreating(false);
              setRevision((r) => r + 1);
            }}
          />
        </Suspense>
      ) : selected ? (
        <>
          <div className="flex flex-wrap items-center gap-3 border-b pb-3">
            {!readOnly && (
              <DsButton size="sm" onClick={() => onStartPaper(selected)}>
                <Play size={16} />
                {t('batch.start')}
              </DsButton>
            )}
            <select
              aria-label={t('paper.exportFormat')}
              value={format}
              onChange={(e) => setFormat(e.target.value as typeof format)}
              className="min-h-9 rounded-md border bg-background px-2 text-sm"
            >
              {['pdf', 'word', 'markdown'].map((f) => (
                <option key={f} value={f}>
                  {t(`paper.format.${f}`)}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={answers}
                onChange={(e) => setAnswers(e.target.checked)}
              />
              {t('paper.includeAnswers')}
            </label>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={explanations}
                onChange={(e) => setExplanations(e.target.checked)}
              />
              {t('paper.includeExplanations')}
            </label>
            <DsButton
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void exportPaper(selected)}
            >
              {busy ? <CircleNotch size={16} className="animate-spin" /> : <Download size={16} />}
              {t('paper.export')}
            </DsButton>
          </div>
          <PracticeRecords scopeId={examId} paperId={selected.id} onOpen={onOpenPractice} readOnly={readOnly} />
          <div className="mx-auto max-w-3xl divide-y">
            {selected.questions.map((q, index) => (
              <section key={q.id} className="space-y-3 py-5">
                <h4 className="text-sm font-medium">
                  {index + 1}. {t(`questionType.${q.question_type}`)}
                </h4>
                {!!q.materials?.length && <QuestionMaterialView materials={q.materials} />}
                <MarkdownRenderer content={q.content} />
                {q.options?.map((o) => (
                  <div key={o.key} className="flex gap-2 text-sm">
                    <span>{o.key}.</span>
                    <MarkdownRenderer content={o.content} />
                  </div>
                ))}
              </section>
            ))}
          </div>
        </>
      ) : (
        <>
          {!papers.length && (
            <div className="py-12 text-center text-sm text-muted-foreground">
              <FileText size={28} className="mx-auto mb-3" />
              {t('batch.noPapers')}
            </div>
          )}
          <div className="divide-y">
          {papers.map((paper) => (
              <div key={paper.id} className="flex flex-wrap items-center gap-3 py-3">
                <FileText size={20} className="shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  {renaming === paper.id ? (
                    <form
                      className="flex flex-wrap gap-2"
                      onSubmit={async (e) => {
                        e.preventDefault();
                        try {
                          await practiceApi.updatePaper(paper.id, title, false);
                          setRenaming(null);
                          setRevision((r) => r + 1);
                        } catch (error) {
                          setError(getErrorMessage(error));
                        }
                      }}
                    >
                      <input
                        aria-label={t('paper.paperTitle')}
                        className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-sm"
                        value={title}
                        maxLength={200}
                        onChange={(e) => setTitle(e.target.value)}
                      />
                      <DsButton type="submit" size="sm">
                        {t('common:save')}
                      </DsButton>
                      <DsButton variant="ghost" size="sm" onClick={() => setRenaming(null)}>
                        {t('common:cancel')}
                      </DsButton>
                    </form>
                  ) : (
                    <>
                      <DsButton
                        variant="ghost"
                        size="sm"
                        className="!h-auto !max-w-full !justify-start !px-0 !text-left"
                        onClick={() => setSelected(paper)}
                      >
                        <span className="truncate">{paper.title}</span>
                      </DsButton>
                      <p className="text-xs text-muted-foreground">
                        {paper.questions.length} {t('paper.questions')} ·{' '}
                        {new Date(paper.created_at).toLocaleString()}
                      </p>
                    <p className="text-xs text-muted-foreground">{records.some(r => r.paper_id === paper.id && r.status === 'draft') ? t('batch.inProgress') : records.some(r => r.paper_id === paper.id) ? t('batch.viewResult') : t('batch.notStarted')}{(() => {
                      const latest = records.filter(r => r.paper_id === paper.id && r.status !== 'draft').sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
                      return latest ? ` · ${t('batch.lastResult', { correct: latest.correct_count, total: latest.question_count })}` : '';
                    })()}</p>
                    </>
                  )}
                </div>
                <DsButton variant="outline" size="sm" onClick={() => setSelected(paper)}>
                  <FileText size={16} />
                  {t('batch.openPaper')}
                </DsButton>
                {!readOnly && (
                  <>
                    <DsButton
                      variant="ghost"
                      size="icon"
                      iconOnly
                      aria-label={t('batch.rename')}
                      title={t('batch.rename')}
                      onClick={() => {
                        setRenaming(paper.id);
                        setTitle(paper.title);
                      }}
                    >
                      <PencilSimple size={16} />
                    </DsButton>
                    <DsButton
                      variant="ghost"
                      size="icon"
                      iconOnly
                      aria-label={t('common:delete')}
                      title={t('common:delete')}
                      onClick={() => setDeleting(paper.id)}
                    >
                      <Trash size={16} />
                    </DsButton>
                  </>
                )}
                {deleting === paper.id && (
                  <div className="flex w-full items-center justify-end gap-2">
                    <span className="mr-auto text-xs text-muted-foreground">
                      {t('batch.deletePaper')}
                    </span>
                    <DsButton variant="ghost" size="sm" onClick={() => setDeleting(null)}>
                      {t('common:cancel')}
                    </DsButton>
                    <DsButton
                      variant="danger"
                      size="sm"
                      onClick={async () => {
                        try {
                          await practiceApi.updatePaper(paper.id, null, true);
                          setDeleting(null);
                          setRevision((r) => r + 1);
                        } catch (error) {
                          setError(getErrorMessage(error));
                        }
                      }}
                    >
                      {t('common:delete')}
                    </DsButton>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </CustomScrollArea>
  );
}
