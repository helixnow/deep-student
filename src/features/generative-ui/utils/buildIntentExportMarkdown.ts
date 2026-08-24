/**
 * 将任意 GenerativeUIIntent 导出为可读 Markdown。
 * 纯函数：只读 intent，不执行 action / 不写剪贴板 / 不触达 IO。
 */

import type { GenerativeBlockIntent, GenerativeUIIntent } from '../types';

type Props = Record<string, unknown>;

export interface IntentExportMarkdownLabels {
  emptyTable: string;
  chartKind: string;
  chartUnit: string;
  chartCategories: string;
  chartSeriesFallback: string;
  statFallbackTitle: string;
  flashcardDeck: string;
  flashcardFront: string;
  flashcardBack: string;
  flashcardTags: string;
  reviewDayFallback: string;
  reviewDue: string;
  reviewDone: string;
  mistakeErrorRate: string;
  mistakeCount: string;
}

const DEFAULT_INTENT_EXPORT_MARKDOWN_LABELS: IntentExportMarkdownLabels = {
  emptyTable: '(empty table)',
  chartKind: 'kind',
  chartUnit: 'unit',
  chartCategories: '类别',
  chartSeriesFallback: '系列',
  statFallbackTitle: '指标',
  flashcardDeck: 'deck',
  flashcardFront: '正面',
  flashcardBack: '背面',
  flashcardTags: 'tags',
  reviewDayFallback: 'day',
  reviewDue: 'due',
  reviewDone: 'done',
  mistakeErrorRate: '错误率',
  mistakeCount: '错题数',
};

function asRecord(value: unknown): Props {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Props) : {};
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

function stringifyScalar(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return '';
}

function blockHeading(block: GenerativeBlockIntent): string {
  const props = asRecord(block.props);
  return (
    asTrimmedString(props.title) ??
    asTrimmedString(props.heading) ??
    asTrimmedString(props.topic) ??
    block.type
  );
}

function checkboxMark(status: unknown): string {
  if (status === 'done') return '[x]';
  if (status === 'active') return '[~]';
  return '[ ]';
}

function escapeTableCell(value: unknown): string {
  return stringifyScalar(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function formatTable(props: Props, labels: IntentExportMarkdownLabels): string[] {
  const columns = Array.isArray(props.columns) ? props.columns : [];
  const rows = Array.isArray(props.rows) ? props.rows : [];
  const parsedColumns = columns
    .map((col) => asRecord(col))
    .filter((col) => asTrimmedString(col.key) || asTrimmedString(col.label));

  if (parsedColumns.length === 0) {
    return rows.length === 0 ? [] : [labels.emptyTable];
  }

  const headers = parsedColumns.map((col) =>
    escapeTableCell(asTrimmedString(col.label) ?? asTrimmedString(col.key) ?? ''),
  );
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${parsedColumns.map(() => '---').join(' | ')} |`,
  ];

  for (const rawRow of rows) {
    const row = asRecord(rawRow);
    const cells = parsedColumns.map((col) => escapeTableCell(row[String(col.key ?? '')]));
    lines.push(`| ${cells.join(' | ')} |`);
  }

  if (asTrimmedString(props.caption)) {
    lines.push(`_${asTrimmedString(props.caption)}_`);
  }
  return lines;
}

function formatChart(props: Props, labels: IntentExportMarkdownLabels): string[] {
  const lines: string[] = [];
  const kind = asTrimmedString(props.kind);
  const unit = asTrimmedString(props.unit);
  if (kind) lines.push(`- ${labels.chartKind}: ${kind}`);
  if (unit) lines.push(`- ${labels.chartUnit}: ${unit}`);

  const categories = Array.isArray(props.categories)
    ? props.categories.filter((item): item is string => typeof item === 'string')
    : [];
  if (categories.length > 0) {
    lines.push(`- ${labels.chartCategories}: ${categories.join(', ')}`);
  }

  const series = Array.isArray(props.series) ? props.series : [];
  for (const raw of series) {
    const item = asRecord(raw);
    const name = asTrimmedString(item.name) ?? labels.chartSeriesFallback;
    const values = Array.isArray(item.values)
      ? item.values.map((v) => stringifyScalar(v)).filter((v) => v.length > 0)
      : [];
    lines.push(`- ${name}: ${values.join(', ')}`);
  }
  return lines;
}

function formatStepList(steps: unknown): string[] {
  if (!Array.isArray(steps)) return [];
  const lines: string[] = [];
  for (const raw of steps) {
    const step = asRecord(raw);
    const label = asTrimmedString(step.label);
    if (!label) continue;
    const extra = asTrimmedString(step.description) ?? asTrimmedString(step.durationLabel);
    lines.push(`- ${checkboxMark(step.status)} ${label}${extra ? ` — ${extra}` : ''}`);
  }
  return lines;
}

function formatListItems(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  const lines: string[] = [];
  for (const raw of items) {
    const item = asRecord(raw);
    const label = asTrimmedString(item.label);
    if (!label) continue;
    const parts = [label];
    const description = asTrimmedString(item.description);
    const badge = asTrimmedString(item.badge);
    if (description) parts.push(description);
    if (badge) parts.push(`(${badge})`);
    lines.push(`- ${parts.join(' — ')}`);
  }
  return lines;
}

function formatKeyValueRows(rows: unknown): string[] {
  if (!Array.isArray(rows)) return [];
  const lines: string[] = [];
  for (const raw of rows) {
    const row = asRecord(raw);
    const key = asTrimmedString(row.key);
    const value = asTrimmedString(row.value);
    if (!key && !value) continue;
    lines.push(`- ${key ?? '?'}: ${value ?? ''}`);
  }
  return lines;
}

function formatReviewDays(days: unknown, labels: IntentExportMarkdownLabels): string[] {
  if (!Array.isArray(days)) return [];
  const lines: string[] = [];
  for (const raw of days) {
    const day = asRecord(raw);
    const date = asTrimmedString(day.date) ?? asTrimmedString(day.label) ?? labels.reviewDayFallback;
    const due = stringifyScalar(day.dueCount);
    const completed = stringifyScalar(day.completedCount);
    const suffix = completed
      ? ` ${labels.reviewDue} ${due}, ${labels.reviewDone} ${completed}`
      : `: ${due}`;
    lines.push(`- ${date}${suffix}`);
  }
  return lines;
}

function formatFindings(findings: unknown): string[] {
  if (!Array.isArray(findings)) return [];
  return findings
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => `- ${item.trim()}`);
}

function formatActions(actions: unknown): string[] {
  if (!Array.isArray(actions)) return [];
  const lines: string[] = [];
  for (const raw of actions) {
    const action = asRecord(raw);
    const label = asTrimmedString(action.label) ?? asTrimmedString(action.id);
    if (label) lines.push(`- ${label}`);
  }
  return lines;
}

function formatStatCard(props: Props, labels: IntentExportMarkdownLabels): string[] {
  const title = asTrimmedString(props.title) ?? labels.statFallbackTitle;
  const value = stringifyScalar(props.value);
  const lines = [`${title}: ${value}`];
  const subtitle = asTrimmedString(props.subtitle);
  if (subtitle) lines.push(subtitle);
  const trend = asTrimmedString(props.trend);
  const trendLabel = asTrimmedString(props.trendLabel);
  if (trend || trendLabel) {
    lines.push([trend, trendLabel].filter(Boolean).join(' · '));
  }
  return lines;
}

function formatBlockBody(
  type: string,
  props: Props,
  labels: IntentExportMarkdownLabels,
): string[] {
  switch (type) {
    case 'stat-card':
      return formatStatCard(props, labels);
    case 'alert': {
      const description = asTrimmedString(props.description);
      return description ? [description] : [];
    }
    case 'list':
      return formatListItems(props.items);
    case 'progress': {
      const current = stringifyScalar(props.current);
      const total = stringifyScalar(props.total);
      const label = asTrimmedString(props.label);
      const line = `${current} / ${total}`;
      return [label ? `${label}: ${line}` : line];
    }
    case 'action-bar':
      return formatActions(props.actions);
    case 'text':
    case 'markdown':
    case 'research-report': {
      const body = asTrimmedString(props.body);
      return body ? [body] : [];
    }
    case 'key-value-grid':
      return formatKeyValueRows(props.rows);
    case 'flashcard-preview': {
      const lines: string[] = [];
      const front = asTrimmedString(props.front);
      const back = asTrimmedString(props.back);
      const deckName = asTrimmedString(props.deckName);
      if (deckName) lines.push(`- ${labels.flashcardDeck}: ${deckName}`);
      if (front) lines.push(`- ${labels.flashcardFront}: ${front}`);
      if (back) lines.push(`- ${labels.flashcardBack}: ${back}`);
      if (Array.isArray(props.tags)) {
        const tags = props.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
        if (tags.length > 0) lines.push(`- ${labels.flashcardTags}: ${tags.join(', ')}`);
      }
      return lines;
    }
    case 'review-calendar':
      return formatReviewDays(props.days, labels);
    case 'mistake-analysis': {
      const lines: string[] = [];
      if (typeof props.errorRate === 'number') {
        lines.push(`${labels.mistakeErrorRate}: ${props.errorRate}%`);
      }
      if (typeof props.mistakeCount === 'number') {
        lines.push(`${labels.mistakeCount}: ${props.mistakeCount}`);
      }
      const suggestion = asTrimmedString(props.suggestion);
      if (suggestion) lines.push(suggestion);
      return lines;
    }
    case 'mindmap-embed': {
      const lines: string[] = [];
      const mindmapId = asTrimmedString(props.mindmapId);
      const versionId = asTrimmedString(props.versionId);
      if (mindmapId) lines.push(`- mindmapId: ${mindmapId}`);
      if (versionId) lines.push(`- versionId: ${versionId}`);
      return lines;
    }
    case 'paper-digest': {
      const lines: string[] = [];
      const meta = [props.authors, props.venue, props.year]
        .map((v) => stringifyScalar(v))
        .filter((v) => v.length > 0);
      if (meta.length > 0) lines.push(meta.join(' · '));
      const excerpt = asTrimmedString(props.abstractExcerpt);
      if (excerpt) lines.push(excerpt);
      lines.push(...formatFindings(props.keyFindings));
      return lines;
    }
    case 'research-plan':
    case 'steps':
      return formatStepList(props.steps);
    case 'chart':
      return formatChart(props, labels);
    case 'table':
      return formatTable(props, labels);
    default: {
      const fallback = Object.entries(props)
        .filter(([key]) => key !== 'id')
        .map(([key, value]) => {
          if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            return `- ${key}: ${stringifyScalar(value)}`;
          }
          return null;
        })
        .filter((line): line is string => Boolean(line));
      return fallback;
    }
  }
}

function formatBlock(
  block: GenerativeBlockIntent,
  labels: IntentExportMarkdownLabels,
): string[] {
  const heading = `### ${blockHeading(block)}`;
  const body = formatBlockBody(block.type, asRecord(block.props), labels);
  return body.length > 0 ? [heading, '', ...body] : [heading];
}

/** 任意 intent → 可读 Markdown（无副作用） */
export function buildIntentExportMarkdown(
  intent: GenerativeUIIntent,
  labels?: Partial<IntentExportMarkdownLabels>,
): string {
  const resolvedLabels = { ...DEFAULT_INTENT_EXPORT_MARKDOWN_LABELS, ...labels };
  const lines: string[] = [];
  const title = intent.meta?.title?.trim();
  if (title) {
    lines.push(`# ${title}`, '');
  }

  for (const block of intent.blocks ?? []) {
    lines.push(...formatBlock(block, resolvedLabels), '');
  }

  return lines.join('\n').replace(/\n+$/, '').trim();
}
