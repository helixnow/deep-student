import React, { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface QuestionSourceRange {
  source_id: string;
  start_page: number | null;
  end_page: number | null;
}

export interface QuestionSourceDescriptor {
  source_id: string;
  name?: string;
  format?: string;
  page_count?: number | null;
}

export interface QuestionSourcePlannedRange {
  source_id: string;
  start_page: number;
  end_page: number;
  chapter_labels?: string[];
  dependency_safe?: boolean;
}

export interface QuestionSourceRangePlan {
  schema_version?: number;
  total_pages?: number;
  ranges: QuestionSourcePlannedRange[];
  warnings: string[];
  automatic?: boolean;
  requires_user_selection?: boolean;
}

export interface QuestionSourceCoverageEntry {
  source_id: string;
  page: number | null;
  status?: string;
}

export interface QuestionSourceImportMetadata {
  model?: { name?: string };
  visual_fallback?: { name?: string } | null;
  complete_document?: boolean;
  sources?: QuestionSourceDescriptor[];
  expected_coverage?: QuestionSourceCoverageEntry[];
  original_coverage?: QuestionSourceCoverageEntry[];
  source_scope?: { complete_document?: boolean; scoped?: boolean };
}

interface SourceRangeFailure {
  plan: QuestionSourceRangePlan;
  sources: QuestionSourceDescriptor[];
  sessionId?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try { return asRecord(JSON.parse(value)); } catch { return null; }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

const positivePage = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** Only a structured provider-limit error can open a range-selection retry. */
export function readQuestionSourceRangeFailure(error: unknown): SourceRangeFailure | null {
  const root = asRecord(error);
  const details = asRecord(root?.details)
    ?? asRecord(asRecord(root?.message)?.details);
  if (details?.code !== 'SOURCE_RANGE_PLAN_REQUIRED') return null;
  const rawPlan = asRecord(details.plan);
  if (!rawPlan || !Array.isArray(rawPlan.ranges)) return null;
  const ranges: QuestionSourcePlannedRange[] = [];
  for (const candidate of rawPlan.ranges) {
    const range = asRecord(candidate);
    if (!range || typeof range.source_id !== 'string' || !range.source_id.trim()
      || !positivePage(range.start_page) || !positivePage(range.end_page)
      || range.end_page < range.start_page) return null;
    ranges.push({
      source_id: range.source_id,
      start_page: range.start_page,
      end_page: range.end_page,
      dependency_safe: range.dependency_safe === true,
      chapter_labels: Array.isArray(range.chapter_labels)
        ? range.chapter_labels.filter((label): label is string => typeof label === 'string')
        : [],
    });
  }
  if (!ranges.length) return null;
  const sourceBundle = asRecord(details.source_bundle);
  const rawSources = details.original_sources ?? details.sources ?? sourceBundle?.sources ?? rawPlan.sources;
  const sources = Array.isArray(rawSources) ? rawSources.flatMap(value => {
    const source = asRecord(value);
    if (!source || typeof source.source_id !== 'string') return [];
    const pageCount = source.page_count;
    return [{
      source_id: source.source_id,
      name: typeof source.name === 'string' ? source.name : undefined,
      format: typeof source.format === 'string' ? source.format : undefined,
      page_count: pageCount === null ? null : positivePage(pageCount) ? pageCount : undefined,
    }];
  }) : [];
  return {
    plan: {
      ranges,
      warnings: Array.isArray(rawPlan.warnings)
        ? rawPlan.warnings.filter((warning): warning is string => typeof warning === 'string') : [],
      total_pages: positivePage(rawPlan.total_pages) ? rawPlan.total_pages : undefined,
      automatic: rawPlan.automatic === true,
      requires_user_selection: rawPlan.requires_user_selection !== false,
    },
    sources,
    sessionId: typeof details.session_id === 'string' ? details.session_id : undefined,
  };
}

interface RangeRow {
  key: string;
  source: QuestionSourceDescriptor;
  checked: boolean;
  start: string;
  end: string;
  maxPage?: number;
  whole: boolean;
  labels: string[];
  dependencySafe: boolean;
}

function makeRangeRows(plan: QuestionSourceRangePlan, sources: readonly QuestionSourceDescriptor[]): RangeRow[] {
  const byId = new Map(sources.map(source => [source.source_id, source]));
  const maxima = new Map<string, number>();
  for (const range of plan.ranges) {
    maxima.set(range.source_id, Math.max(maxima.get(range.source_id) || 0, range.end_page));
  }
  const rows: RangeRow[] = [];
  const keys = new Set<string>();
  for (const range of plan.ranges) {
    const key = `${range.source_id}:${range.start_page}:${range.end_page}`;
    if (keys.has(key)) continue;
    keys.add(key);
    const source = byId.get(range.source_id) || { source_id: range.source_id };
    rows.push({
      key, source, checked: false, whole: false,
      start: String(range.start_page), end: String(range.end_page),
      maxPage: source.page_count ?? maxima.get(range.source_id),
      labels: range.chapter_labels || [], dependencySafe: range.dependency_safe === true,
    });
  }
  for (const source of sources) {
    if (maxima.has(source.source_id)) continue;
    if (source.page_count !== null && !positivePage(source.page_count)) continue;
    rows.push({
      key: `${source.source_id}:whole`, source, checked: false,
      whole: source.page_count === null,
      start: '1', end: String(source.page_count ?? ''), maxPage: source.page_count ?? undefined,
      labels: [], dependencySafe: false,
    });
  }
  return rows;
}

export interface QuestionSourceRangePickerProps {
  plan: QuestionSourceRangePlan;
  sources?: readonly QuestionSourceDescriptor[];
  onChange: (ranges: QuestionSourceRange[], valid: boolean) => void;
  disabled?: boolean;
}

const EMPTY_SOURCES: readonly QuestionSourceDescriptor[] = [];

export function QuestionSourceRangePicker({
  plan, sources = EMPTY_SOURCES, onChange, disabled = false,
}: QuestionSourceRangePickerProps) {
  const { t } = useTranslation('exam_sheet');
  const id = useId();
  const [rows, setRows] = useState(() => makeRangeRows(plan, sources));
  useEffect(() => { setRows(makeRangeRows(plan, sources)); }, [plan, sources]);
  const selection = useMemo(() => {
    const ranges: QuestionSourceRange[] = [];
    let error: 'bounds' | 'overlap' | null = null;
    let pageCount = 0;
    let wholeCount = 0;
    for (const row of rows.filter(row => row.checked)) {
      const start = Number(row.start);
      const end = Number(row.end);
      if (!row.whole && (!positivePage(start) || !positivePage(end)
        || end < start || (row.maxPage !== undefined && end > row.maxPage))) {
        error = 'bounds';
        continue;
      }
      const range: QuestionSourceRange = {
        source_id: row.source.source_id,
        start_page: row.whole ? null : start,
        end_page: row.whole ? null : end,
      };
      if (ranges.some(previous => previous.source_id === range.source_id
        && (previous.start_page === null || range.start_page === null
          || (previous.start_page <= end && previous.end_page! >= start)))) error = 'overlap';
      ranges.push(range);
      if (row.whole) wholeCount++;
      else pageCount += end - start + 1;
    }
    return { ranges: error ? [] : ranges, valid: !error && ranges.length > 0, error, pageCount, wholeCount };
  }, [rows]);
  useEffect(() => { onChange(selection.ranges, selection.valid); }, [selection, onChange]);
  const update = (key: string, patch: Partial<RangeRow>) => {
    setRows(previous => previous.map(row => row.key === key ? { ...row, ...patch } : row));
  };
  const sourceIds = [...new Set(rows.map(row => row.source.source_id))];

  return (
    <section className="min-w-0 space-y-3 border-t border-border/50 pt-3" data-testid="question-source-range-picker">
      <h3 className="text-sm font-medium">{t('uploader.ranges.title', { defaultValue: 'Original source ranges' })}</h3>
      {plan.warnings.length > 0 && (
        <ul className="list-inside list-disc space-y-1 break-words text-xs text-warning" aria-label={t('uploader.ranges.warnings', { defaultValue: 'Range plan warnings' })}>
          {plan.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
        </ul>
      )}
      {sourceIds.map(sourceId => {
        const sourceRows = rows.filter(row => row.source.source_id === sourceId);
        const source = sourceRows[0].source;
        return (
          <fieldset key={sourceId} disabled={disabled} className="min-w-0 space-y-2 border-t border-border/30 pt-2">
            <legend className="max-w-full break-words pr-2 text-sm font-medium">
              {source.name || sourceId}
              <span className="ml-2 break-all font-mono text-xs font-normal text-muted-foreground">{sourceId}</span>
            </legend>
            {sourceRows.map((row, index) => {
              const controlId = `${id}-${row.key}`;
              const label = row.whole
                ? t('uploader.ranges.whole_source', { defaultValue: 'Entire native source' })
                : t('uploader.ranges.range_number', { defaultValue: 'Range {{number}}', number: index + 1 });
              return (
                <div key={row.key} className="min-w-0 space-y-1" data-testid="source-range-row" data-source-id={sourceId}>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-sm">
                    <label htmlFor={controlId} className="flex min-h-9 cursor-pointer items-center gap-2">
                      <input id={controlId} type="checkbox" checked={row.checked}
                        className="h-4 w-4 shrink-0 accent-primary"
                        onChange={event => update(row.key, { checked: event.target.checked })} />
                      <span className="break-words">{label}</span>
                    </label>
                    {!row.whole && (
                      <div className="flex max-w-full items-center gap-2">
                        <input type="number" min={1} max={row.maxPage} step={1} value={row.start}
                          aria-label={`${source.name || sourceId} ${label} ${t('uploader.ranges.start_page', { defaultValue: 'Start page' })}`}
                          className="h-9 w-20 min-w-0 rounded border border-border bg-background px-2 tabular-nums"
                          onChange={event => update(row.key, { start: event.target.value })} />
                        <span aria-hidden="true">-</span>
                        <input type="number" min={1} max={row.maxPage} step={1} value={row.end}
                          aria-label={`${source.name || sourceId} ${label} ${t('uploader.ranges.end_page', { defaultValue: 'End page' })}`}
                          className="h-9 w-20 min-w-0 rounded border border-border bg-background px-2 tabular-nums"
                          onChange={event => update(row.key, { end: event.target.value })} />
                      </div>
                    )}
                  </div>
                  {(row.labels.length > 0 || !row.dependencySafe) && (
                    <p className="break-words pl-6 text-xs text-muted-foreground">
                      {row.labels.join(' / ')}
                      {!row.dependencySafe && <span className="ml-1 text-warning">{t('uploader.ranges.dependency_review', { defaultValue: 'Material and answer dependencies require review' })}</span>}
                    </p>
                  )}
                </div>
              );
            })}
          </fieldset>
        );
      })}
      <p className="text-xs text-muted-foreground" role="status" data-testid="source-range-selection-summary">
        {t('uploader.ranges.selection_count', { defaultValue: 'Selected: {{pages}} pages, {{sources}} entire native sources', pages: selection.pageCount, sources: selection.wholeCount })}
      </p>
      {selection.error && <p className="text-xs text-destructive" role="alert">
        {selection.error === 'bounds'
          ? t('uploader.ranges.invalid_bounds', { defaultValue: 'Page bounds must be whole numbers within the original source.' })
          : t('uploader.ranges.overlap', { defaultValue: 'Selected ranges must not overlap within the same source.' })}
      </p>}
    </section>
  );
}

const coverageKey = (entry: QuestionSourceCoverageEntry) => JSON.stringify([entry.source_id, entry.page]);

export function buildQuestionSourceCoverage(
  metadata: QuestionSourceImportMetadata | null | undefined,
  coverage: readonly QuestionSourceCoverageEntry[] = [],
): QuestionSourceCoverageEntry[] {
  const declared = new Map(coverage.map(entry => [coverageKey(entry), entry]));
  const expected = metadata?.expected_coverage;
  const sent = expected ? new Set(expected.map(coverageKey)) : null;
  const originals = metadata?.original_coverage ?? expected ?? (metadata?.sources || []).flatMap(source => {
    if (source.page_count === null) return [{ source_id: source.source_id, page: null }];
    if (!positivePage(source.page_count)) return [];
    return Array.from({ length: source.page_count }, (_, page) => ({ source_id: source.source_id, page: page + 1 }));
  });
  const all = new Map([...originals, ...coverage].map(entry => [coverageKey(entry), entry]));
  return [...all.values()].map(entry => {
    const actual = declared.get(coverageKey(entry));
    return { ...entry, status: sent && !sent.has(coverageKey(entry))
      ? 'unprocessed' : actual?.status || 'unprocessed' };
  }).sort((a, b) => a.source_id.localeCompare(b.source_id) || (a.page ?? 0) - (b.page ?? 0));
}

export function QuestionSourceCoverage({
  metadata, coverage,
}: { metadata?: QuestionSourceImportMetadata | null; coverage?: QuestionSourceCoverageEntry[] }) {
  const { t } = useTranslation('exam_sheet');
  const entries = buildQuestionSourceCoverage(metadata, coverage);
  const partialSource = metadata?.complete_document === false || metadata?.source_scope?.complete_document === false;
  if (!entries.length && !partialSource) return null;
  const groups: Array<{ source_id: string; start: number | null; end: number | null; status: string }> = [];
  for (const entry of entries) {
    const previous = groups[groups.length - 1];
    if (previous && previous.source_id === entry.source_id && previous.status === entry.status
      && previous.end !== null && entry.page === previous.end + 1) previous.end = entry.page;
    else groups.push({ source_id: entry.source_id, start: entry.page, end: entry.page, status: entry.status! });
  }
  return (
    <section className="min-w-0 space-y-2 border-y border-border/40 py-3" data-testid="question-source-coverage">
      <h4 className="text-sm font-medium">{t('uploader.ranges.coverage', { defaultValue: 'Source coverage' })}</h4>
      {partialSource && <p className="text-xs text-warning">
        {t('uploader.ranges.partial_source', { defaultValue: 'Partial source only. The full document has not been processed.' })}
      </p>}
      <p className="text-xs text-muted-foreground">{t('uploader.ranges.coverage_count', {
        defaultValue: 'Processed source units: {{processed}} / {{total}}',
        processed: entries.filter(entry => entry.status === 'processed').length, total: entries.length,
      })}</p>
      <ul className="space-y-1 text-xs">
        {groups.map((group, index) => <li key={index} className="flex min-w-0 flex-wrap gap-x-2 gap-y-0.5" data-status={group.status}>
          <span className="min-w-0 break-words">{metadata?.sources?.find(source => source.source_id === group.source_id)?.name || group.source_id}</span>
          <span className="tabular-nums text-muted-foreground">{group.start === null
            ? t('uploader.ranges.whole_source', { defaultValue: 'Entire native source' })
            : t('uploader.ranges.page_span', { defaultValue: 'Pages {{start}}-{{end}}', start: group.start, end: group.end })}</span>
          <span className={group.status === 'processed' ? 'text-success' : 'text-warning'}>
            {group.status === 'processed' ? t('uploader.ranges.processed', { defaultValue: 'Processed' })
              : group.status === 'unprocessed' || group.status === 'not_selected'
                ? t('uploader.ranges.unprocessed', { defaultValue: 'Not processed' })
                : t('uploader.ranges.uncertain', { defaultValue: 'Requires review' })}
          </span>
        </li>)}
      </ul>
    </section>
  );
}
