/**
 * 跨题目集错题本：Finder「题目集」入口下的「错题本」视图。
 * 错题 = 答错后还没掌握的题（status review，与题目集内「错题本」同口径）；按题目集 / 关键词筛选，
 * 展开看我的答案与正确答案，可回题目集重做、问 AI、生成同类题；顶部直达「到期错题复习」，
 * 勾选一批（不勾就是当前列出的）可当一套题重做。
 */
import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowClockwise, ArrowCounterClockwise, ArrowSquareOut, CaretDown, Lightning } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { Checkbox } from '@/components/ui/shad/Checkbox';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { QuestionFollowUpBar } from '@/components/practice/QuestionFollowUpBar';
import { getReviewQuestionTypeMeta } from '@/components/review/reviewQuestionTypeMeta';
import { ERROR_CAUSE_STYLE, getErrorCauses } from '@/components/review/errorCauses';
import { openDueMistakesReview } from '@/features/learning-today/dueMistakesReview';
import { CardMathText } from '@/features/flashcards/cardMathPreview';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { getErrorMessage } from '@/utils/errorUtils';
import { cn } from '@/lib/utils';
import {
  MISTAKE_REDO_LIMIT,
  listMistakes,
  type MistakeExamCount,
  type MistakeItem,
  type MistakeSort,
} from './mistakeBookApi';
import { openQuestionInExam } from './mistakeBookNavigation';
import './mistakeBook.css';

// 重做浮层带着整套做题界面：点了才加载
const LazyMistakeRedoOverlay = React.lazy(() => import('./MistakeRedoOverlay'));

/** 题目集下拉的「全部」取值（题目集 id 不会以 `::` 开头） */
const EXAM_FILTER_ALL = '::all';
const DAY_MS = 86_400_000;

function relativeDay(iso: string | undefined, locale: string): string | null {
  if (!iso) return null;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOfDay(new Date()) - startOfDay(then)) / DAY_MS);
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-Math.max(0, days), 'day');
}

const MistakeRow: React.FC<{
  item: MistakeItem;
  expanded: boolean;
  onToggle: () => void;
  selected: boolean;
  onSelect: (selected: boolean) => void;
}> = ({ item, expanded, onToggle, selected, onSelect }) => {
  const { t, i18n } = useTranslation(['learningHub', 'review']);
  const { question, examId, examName } = item;
  const causes = getErrorCauses(question);
  const errors = Math.max(0, (question.attemptCount ?? 0) - (question.correctCount ?? 0));
  const meta = [
    examName || t('learningHub:mistakeBook.untitledExam'),
    t(getReviewQuestionTypeMeta(question.questionType).labelKey),
    t('learningHub:mistakeBook.wrongTimes', { count: errors }),
    relativeDay(question.lastAttemptAt, i18n.language),
  ].filter(Boolean).join(' · ');
  const detailId = `mb-detail-${question.id}`;
  const stemId = `mb-stem-${question.id}`;

  return (
    <li className="mb-item" data-expanded={expanded ? 'true' : undefined}>
      <div className="mb-line">
        <Checkbox
          checked={selected}
          onCheckedChange={(value) => onSelect(value === true)}
          aria-labelledby={stemId}
        />
        <DsButton
          variant="ghost"
          className="mb-row"
          aria-expanded={expanded}
          aria-controls={expanded ? detailId : undefined}
          onClick={onToggle}
        >
          <span className="mb-row-body">
            <span id={stemId} className="mb-row-stem">
              {question.content ? <CardMathText text={question.content} inline /> : t('review:questions.noContent')}
            </span>
            <span className="mb-row-meta">{meta}</span>
          </span>
          {causes[0] ? (
            <span className={cn('mb-chip', ERROR_CAUSE_STYLE[causes[0]])}>
              {t(`review:questions.errorCause.${causes[0]}`)}
            </span>
          ) : null}
        </DsButton>
      </div>
      {expanded ? (
        <div id={detailId} className="mb-detail">
          <p className="mb-detail-stem"><CardMathText text={question.content} /></p>
          {question.options?.length ? (
            <ul className="mb-detail-options">
              {question.options.map((option) => (
                <li key={option.key}>
                  <span className="mb-option-key">{option.key}.</span> <CardMathText text={option.content} />
                </li>
              ))}
            </ul>
          ) : null}
          <dl className="mb-answers">
            <div data-tone="mine">
              <dt>{t('learningHub:mistakeBook.myAnswer')}</dt>
              <dd>
                {question.userAnswer?.trim()
                  ? <CardMathText text={question.userAnswer} />
                  : t('learningHub:mistakeBook.noAnswer')}
              </dd>
            </div>
            {question.answer?.trim() ? (
              <div data-tone="correct">
                <dt>{t('learningHub:mistakeBook.correctAnswer')}</dt>
                <dd><CardMathText text={question.answer} /></dd>
              </div>
            ) : null}
          </dl>
          {question.explanation?.trim() ? (
            <p className="mb-explanation">
              <span className="mb-explanation-label">{t('learningHub:mistakeBook.explanation')}</span>
              <CardMathText text={question.explanation} />
            </p>
          ) : null}
          <div className="mb-detail-actions">
            <DsButton variant="ghost" size="sm" onClick={() => openQuestionInExam(examId, question.id)}>
              <ArrowSquareOut size={14} aria-hidden="true" />
              {t('learningHub:mistakeBook.redo')}
            </DsButton>
          </div>
          <QuestionFollowUpBar question={question} examId={examId} userAnswer={question.userAnswer} isCorrect={false} />
        </div>
      ) : null}
    </li>
  );
};

export const MistakeBookView: React.FC<{ search: string }> = ({ search }) => {
  const { t } = useTranslation(['learningHub', 'review']);
  const [examId, setExamId] = useState<string | null>(null);
  const [sort, setSort] = useState<MistakeSort>('recent');
  const [items, setItems] = useState<MistakeItem[]>([]);
  const [exams, setExams] = useState<MistakeExamCount[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [redoIds, setRedoIds] = useState<string[] | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await listMistakes({ examId, search, sort, page: 1 });
      if (requestId !== requestRef.current) return;
      setItems(result.items);
      setExams(result.exams);
      setTotal(result.total);
      setPage(1);
      setHasMore(result.hasMore);
    } catch (err) {
      if (requestId !== requestRef.current) return;
      setError(getErrorMessage(err) || t('learningHub:mistakeBook.loadFailed'));
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [examId, search, sort, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // 做题不发全局事件：回到应用时重读，在题目集里重做答对的题就会移出
  useEventRegistry([{
    target: 'document',
    type: 'visibilitychange',
    listener: () => {
      if (document.visibilityState === 'visible') void load();
    },
  }], [load]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    const requestId = requestRef.current;
    setLoadingMore(true);
    try {
      const result = await listMistakes({ examId, search, sort, page: page + 1 });
      if (requestId !== requestRef.current) return;
      setItems((prev) => {
        const seen = new Set(prev.map((item) => item.question.id));
        return [...prev, ...result.items.filter((item) => !seen.has(item.question.id))];
      });
      setPage(result.page);
      setHasMore(result.hasMore);
      setTotal(result.total);
    } catch (err) {
      if (requestId === requestRef.current) {
        showGlobalNotification('error', getErrorMessage(err) || t('learningHub:mistakeBook.loadFailed'));
      }
    } finally {
      setLoadingMore(false);
    }
  }, [examId, hasMore, loadingMore, page, search, sort, t]);

  // 重读 / 换筛选后，不在列表里的勾选作废
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const listed = new Set(items.map((item) => item.question.id));
      const next = new Set(Array.from(prev).filter((id) => listed.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [items]);

  const toggleSelected = useCallback((questionId: string, selected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (selected) next.add(questionId);
      else next.delete(questionId);
      return next;
    });
  }, []);

  // 勾了就重做勾的，没勾就重做当前列出的；按列表顺序
  const redoSet = useMemo(() => {
    const source = selectedIds.size > 0 ? items.filter((item) => selectedIds.has(item.question.id)) : items;
    return source.slice(0, MISTAKE_REDO_LIMIT).map((item) => item.question.id);
  }, [items, selectedIds]);

  const examNames = useMemo(() => {
    const names: Record<string, string | null> = {};
    for (const item of items) names[item.examId] = item.examName;
    return names;
  }, [items]);

  const closeRedo = useCallback(() => {
    setRedoIds(null);
    setSelectedIds(new Set());
    // 答对的题已移出错题本
    void load();
  }, [load]);

  const allTotal = useMemo(() => exams.reduce((sum, exam) => sum + exam.count, 0), [exams]);
  const filtered = examId !== null || search.trim().length > 0;
  const summary = filtered
    ? t('learningHub:mistakeBook.summaryFiltered', { count: total, all: allTotal })
    : t('learningHub:mistakeBook.summary', { count: total, exams: exams.length });

  return (
    <div className="mb" data-testid="mistake-book">
      <div className="mb-head">
        <p className="mb-summary">{loading && items.length === 0 ? t('learningHub:mistakeBook.loading') : summary}</p>
        <div className="mb-head-actions">
          {selectedIds.size > 0 ? (
            <DsButton variant="ghost" size="sm" onClick={() => setSelectedIds(new Set())}>
              {t('learningHub:mistakeBook.clearSelection')}
            </DsButton>
          ) : null}
          {redoSet.length > 0 ? (
            <DsButton variant="ghost" size="sm" onClick={() => setRedoIds(redoSet)}>
              <ArrowCounterClockwise size={14} aria-hidden="true" />
              {selectedIds.size > 0
                ? t('learningHub:mistakeBook.redoSelected', { count: redoSet.length })
                : t('learningHub:mistakeBook.redoAll', { count: redoSet.length })}
            </DsButton>
          ) : null}
          <DsButton variant="ghost" size="sm" onClick={openDueMistakesReview}>
            <Lightning size={14} aria-hidden="true" />
            {t('learningHub:mistakeBook.reviewDue')}
          </DsButton>
          <DsButton
            variant="ghost"
            size="sm"
            iconOnly
            disabled={loading}
            aria-label={t('learningHub:mistakeBook.refresh')}
            title={t('learningHub:mistakeBook.refresh')}
            onClick={() => void load()}
          >
            <ArrowClockwise size={14} />
          </DsButton>
        </div>
      </div>

      {allTotal > 0 ? (
        <div className="mb-filters">
          {exams.length > 1 || examId !== null ? (
            <span className="mb-select-wrap">
              <select
                className="mb-select"
                aria-label={t('learningHub:mistakeBook.examFilter')}
                value={examId ?? EXAM_FILTER_ALL}
                onChange={(event) => {
                  setExpandedId(null);
                  setExamId(event.target.value === EXAM_FILTER_ALL ? null : event.target.value);
                }}
              >
                <option value={EXAM_FILTER_ALL}>{`${t('learningHub:mistakeBook.allExams')} (${allTotal})`}</option>
                {exams.map((exam) => (
                  <option key={exam.examId} value={exam.examId}>
                    {`${exam.examName || t('learningHub:mistakeBook.untitledExam')} (${exam.count})`}
                  </option>
                ))}
              </select>
              <CaretDown size={10} className="mb-select-caret" aria-hidden="true" />
            </span>
          ) : null}
          <SegmentedControl<MistakeSort>
            ariaLabel={t('learningHub:mistakeBook.sortLabel')}
            size="compact"
            value={sort}
            onValueChange={setSort}
            options={[
              { value: 'recent', label: t('learningHub:mistakeBook.sort.recent') },
              { value: 'errors', label: t('learningHub:mistakeBook.sort.errors') },
            ]}
          />
        </div>
      ) : null}

      <div className="mb-body">
        {loading && items.length === 0 ? null : error ? (
          <div role="alert" className="mb-note">
            <p>{t('learningHub:mistakeBook.loadFailed')}</p>
            <p className="mb-note-detail">{error}</p>
            <DsButton variant="ghost" size="sm" onClick={() => void load()}>
              {t('learningHub:mistakeBook.retry')}
            </DsButton>
          </div>
        ) : items.length === 0 ? (
          <div className="mb-note">
            <p className="mb-note-title">
              {filtered ? t('learningHub:mistakeBook.noMatches') : t('learningHub:mistakeBook.empty')}
            </p>
            {!filtered ? <p className="mb-note-detail">{t('learningHub:mistakeBook.emptyHint')}</p> : null}
          </div>
        ) : (
          <ul className="mb-list">
            {items.map((item) => (
              <MistakeRow
                key={item.question.id}
                item={item}
                expanded={expandedId === item.question.id}
                onToggle={() => setExpandedId((prev) => (prev === item.question.id ? null : item.question.id))}
                selected={selectedIds.has(item.question.id)}
                onSelect={(selected) => toggleSelected(item.question.id, selected)}
              />
            ))}
          </ul>
        )}
        {hasMore && !loading && !error ? (
          <div className="mb-more">
            <DsButton variant="ghost" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
              {t('learningHub:mistakeBook.loadMore')}
            </DsButton>
          </div>
        ) : null}
      </div>

      {redoIds ? (
        <Suspense fallback={null}>
          <LazyMistakeRedoOverlay questionIds={redoIds} examNames={examNames} onClose={closeRedo} />
        </Suspense>
      ) : null}
    </div>
  );
};
