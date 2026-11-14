/**
 * Generative UI 块列表归一化（模型输出容错层）
 *
 * LLM 经常用「同义字段名」表达同一语义（`hint` / `description`、`value` / `current`、
 * `items` / `rows` / `steps` 等）。registry 的 runtime schema 只接受一份权威字段名，
 * 直接校验会把可正常展示的数据判为失败并降级成「参数校验失败」告警。
 *
 * 本模块在渲染前把**无歧义的**别名映射回 schema 字段，并保证：
 * - 只在目标字段缺失（undefined）时填充，已有合法值永不覆盖；
 * - 不做类型强转以外的「猜测」（例如不把任意数字当百分比）；
 * - 无改动时返回原数组引用，避免击穿 memo；
 * - `flashcard-preview` 的 `cards[]` 多卡形式展开为多个块；
 * - 展开后仍受 `MAX_GENERATIVE_UI_BLOCKS` 约束。
 *
 * 注意：`validateBlockProps` / `schema.ts` 保持原样。归一化只发生在渲染路径上，
 * 直接调用 schema 校验的调用方行为不变。
 */

import { MAX_GENERATIVE_UI_BLOCKS } from './schema';
import type { GenerativeBlockIntent } from './types';

type Props = Record<string, unknown>;

function isRecord(value: unknown): value is Props {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** 返回第一个 string 值（保留空串语义，符合 `typeof x === 'string'` 判断） */
function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function toCellValue(value: unknown): string | number {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return String(value ?? '');
}

function shallowEqualProps(a: Props, b: Props): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function alertVariantFromLevel(rawLevel: string): 'default' | 'info' | 'warning' | 'destructive' {
  const level = rawLevel.trim().toLowerCase();
  if (level === 'info') return 'info';
  if (level === 'warning' || level === 'warn') return 'warning';
  if (level === 'error' || level === 'danger' || level === 'destructive') return 'destructive';
  return 'default';
}

function stepStatusFromRaw(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const value = raw.trim().toLowerCase();
  if (value === 'completed' || value === 'finished' || value === 'complete') return 'done';
  if (value === 'current' || value === 'in_progress' || value === 'in-progress' || value === 'running') {
    return 'active';
  }
  if (value === 'todo' || value === 'waiting' || value === 'queued') return 'pending';
  return value;
}

// ============================================================================
// flashcard-preview 多卡展开
// ============================================================================

function expandFlashcardPreview(block: GenerativeBlockIntent): GenerativeBlockIntent[] {
  if (block.type !== 'flashcard-preview') return [block];

  const props = isRecord(block.props) ? block.props : {};
  const hasSingleCard = typeof props.front === 'string' && typeof props.back === 'string';
  if (hasSingleCard || !Array.isArray(props.cards)) return [block];

  const deckName = asText(props.title);
  const expanded: GenerativeBlockIntent[] = [];

  for (const card of props.cards) {
    if (!isRecord(card)) continue;
    const front = asText(card.front);
    const back = asText(card.back);
    if (!front || !back) continue;

    const tags = Array.isArray(card.tags)
      ? card.tags.filter((tag): tag is string => typeof tag === 'string')
      : typeof card.tag === 'string'
        ? [card.tag]
        : undefined;
    const cardDeckName = asText(card.deckName) ?? deckName;

    expanded.push({
      type: 'flashcard-preview',
      props: {
        front,
        back,
        ...(tags && tags.length > 0 ? { tags } : {}),
        ...(cardDeckName !== undefined ? { deckName: cardDeckName } : {}),
      },
      ...(block.span !== undefined ? { span: block.span } : {}),
    });
  }

  // 一张合法卡片都没有时保留原块，让 schema 校验给出可诊断的错误，而不是静默消失。
  return expanded.length > 0 ? expanded : [block];
}

// ============================================================================
// 单块 props 别名归一化
// ============================================================================

function normalizeStatCard(props: Props): Props {
  const next: Props = { ...props };

  if (next.subtitle === undefined) {
    const fallback = firstText(props.hint, props.description);
    if (fallback !== undefined) next.subtitle = fallback.slice(0, 200);
  }

  const unit = asText(props.unit)?.trim();
  if (unit && props.value !== undefined) {
    const rendered = String(props.value);
    if (!rendered.endsWith(unit)) next.value = `${rendered} ${unit}`;
  }

  return shallowEqualProps(next, props) ? props : next;
}

function normalizeAlert(props: Props): Props {
  const next: Props = { ...props };

  if (next.variant === undefined) {
    const level = asText(props.level);
    if (level !== undefined) next.variant = alertVariantFromLevel(level);
  }

  if (next.description === undefined) {
    const fallback = firstText(props.message, props.content);
    if (fallback !== undefined) next.description = fallback.slice(0, 500);
  }

  return shallowEqualProps(next, props) ? props : next;
}

function normalizeList(props: Props): Props {
  if (!Array.isArray(props.items)) return props;

  let changed = false;
  const items = props.items.map((item): unknown => {
    if (typeof item === 'string') {
      changed = true;
      return { label: item.slice(0, 200) };
    }
    if (!isRecord(item)) return item;

    const nextItem: Props = { ...item };
    if (nextItem.label === undefined) {
      const label = firstText(item.text, item.title, item.name);
      if (label !== undefined) nextItem.label = label.slice(0, 200);
    }
    if (nextItem.description === undefined) {
      const description = firstText(item.meta, item.subtitle, item.detail);
      if (description !== undefined) nextItem.description = description.slice(0, 300);
    }
    if (nextItem.badge === undefined) {
      const badge = firstText(item.tag, item.status);
      if (badge !== undefined) nextItem.badge = badge.slice(0, 40);
    }
    if (shallowEqualProps(nextItem, item)) return item;
    changed = true;
    return nextItem;
  });

  return changed ? { ...props, items } : props;
}

function normalizeProgress(props: Props): Props {
  const next: Props = { ...props };

  if (next.current === undefined && isFiniteNumber(props.value)) next.current = props.value;
  if (next.total === undefined) {
    if (isFiniteNumber(props.max)) next.total = props.max;
    else if (next.current !== undefined) next.total = 100;
  }

  return shallowEqualProps(next, props) ? props : next;
}

function normalizeTextBlock(props: Props): Props {
  const next: Props = { ...props };

  if (next.body === undefined) {
    const body = firstText(props.text, props.content);
    if (body !== undefined) next.body = body.slice(0, 4000);
  }
  if (next.heading === undefined) {
    const heading = asText(props.title);
    if (heading !== undefined) next.heading = heading.slice(0, 120);
  }

  return shallowEqualProps(next, props) ? props : next;
}

function normalizeMarkdown(props: Props): Props {
  if (props.body !== undefined) return props;

  const body = firstText(props.content, props.text, props.markdown);
  if (body === undefined) return props;

  return { ...props, body: body.slice(0, 20000) };
}

function normalizeKeyValueGrid(props: Props): Props {
  if (props.rows !== undefined || !Array.isArray(props.items)) return props;

  const rows = props.items
    .filter(isRecord)
    .map((item) => ({
      key: String(item.key ?? item.label ?? item.name ?? '').slice(0, 80),
      value: String(item.value ?? item.val ?? item.content ?? '').slice(0, 300),
    }))
    .filter((row) => row.key.length > 0 && row.value.length > 0);

  if (rows.length === 0) return props;
  return { ...props, rows };
}

function normalizeChart(props: Props): Props {
  const next: Props = { ...props };

  if (next.kind === undefined) {
    const rawKind = firstText(props.chartType, props.type)?.trim().toLowerCase();
    if (rawKind === 'bar' || rawKind === 'line' || rawKind === 'pie') next.kind = rawKind;
  }

  if (Array.isArray(props.categories) && Array.isArray(props.series)) {
    const target = props.categories.length;
    let changed = false;
    const series = props.series.map((item) => {
      if (!isRecord(item) || !Array.isArray(item.values)) return item;
      if (item.values.length === target) return item;
      changed = true;
      const values = item.values.slice(0, target);
      while (values.length < target) values.push(0);
      return { ...item, values };
    });
    if (changed) next.series = series;
  }

  return shallowEqualProps(next, props) ? props : next;
}

function normalizeSteps(props: Props): Props {
  const next: Props = { ...props };

  if (next.steps === undefined && Array.isArray(props.items)) next.steps = props.items;
  if (!Array.isArray(next.steps)) return shallowEqualProps(next, props) ? props : next;

  let changed = false;
  const steps = next.steps.map((step): unknown => {
    if (!isRecord(step)) return step;
    const nextStep: Props = { ...step };
    if (nextStep.label === undefined) {
      const label = firstText(step.title, step.name);
      if (label !== undefined) nextStep.label = label.slice(0, 160);
    }
    const status = stepStatusFromRaw(step.status);
    if (status !== step.status) nextStep.status = status;
    if (shallowEqualProps(nextStep, step)) return step;
    changed = true;
    return nextStep;
  });

  if (!changed) return shallowEqualProps(next, props) ? props : next;
  return { ...next, steps };
}

function normalizeTable(props: Props): Props {
  const next: Props = { ...props };
  let changed = false;

  const rawColumns = Array.isArray(props.columns) ? props.columns : null;
  const allStringColumns = rawColumns?.every((col) => typeof col === 'string') ?? false;
  const columnKeys: string[] = [];

  if (rawColumns) {
    let columnsChanged = false;
    const columns = rawColumns.map((col, index): unknown => {
      if (typeof col === 'string') {
        const key = allStringColumns ? `col_${index}` : col || `col_${index}`;
        columnKeys.push(key);
        if (!allStringColumns) return col;
        columnsChanged = true;
        return { key, label: col };
      }
      if (typeof col === 'number') {
        columnKeys.push(`col_${index}`);
        columnsChanged = true;
        return { key: `col_${index}`, label: String(col) };
      }
      if (!isRecord(col)) {
        columnKeys.push(`col_${index}`);
        return col;
      }

      const nextCol: Props = { ...col };
      const key = firstText(col.key);
      if (nextCol.key === undefined) nextCol.key = key ?? `col_${index}`;
      if (nextCol.label === undefined) {
        const label = firstText(col.title, col.name, col.header) ?? String(nextCol.key ?? '');
        if (label.length > 0) nextCol.label = label.slice(0, 80);
      }
      columnKeys.push(String(nextCol.key ?? `col_${index}`));
      if (shallowEqualProps(nextCol, col)) return col;
      columnsChanged = true;
      return nextCol;
    });
    if (columnsChanged) {
      next.columns = columns;
      changed = true;
    }
  }

  if (Array.isArray(props.rows)) {
    let rowsChanged = false;
    const rows = props.rows.map((row): unknown => {
      if (Array.isArray(row)) {
        rowsChanged = true;
        const record: Props = {};
        row.forEach((cell, index) => {
          record[columnKeys[index] ?? `col_${index}`] = toCellValue(cell);
        });
        return record;
      }
      if (!isRecord(row)) return row;

      const nextRow: Props = {};
      let cellChanged = false;
      for (const [key, value] of Object.entries(row)) {
        const cell = toCellValue(value);
        nextRow[key] = cell;
        if (cell !== value) cellChanged = true;
      }
      if (!cellChanged) return row;
      rowsChanged = true;
      return nextRow;
    });
    if (rowsChanged) {
      next.rows = rows;
      changed = true;
    }
  }

  return changed ? next : props;
}

function normalizeReviewCalendar(props: Props): Props {
  if (Array.isArray(props.days)) return props;

  const source = props.data ?? props.items ?? props.schedule;
  if (!Array.isArray(source)) return props;

  const days = source
    .slice(0, 14)
    .map((entry): Props | null => {
      if (!isRecord(entry)) return null;
      const date = String(entry.date ?? '').slice(0, 20);
      if (date.length === 0) return null;
      const rawDue = Number(entry.dueCount ?? entry.count ?? entry.due ?? 0);
      return {
        date,
        ...(typeof entry.label === 'string' ? { label: entry.label.slice(0, 40) } : {}),
        dueCount: Number.isFinite(rawDue) && rawDue >= 0 ? rawDue : 0,
        ...(entry.completedCount !== undefined
          ? { completedCount: Number(entry.completedCount) }
          : {}),
      };
    })
    .filter((day): day is Props => day !== null);

  if (days.length === 0) return props;
  return { ...props, days };
}

function normalizeMistakeAnalysis(props: Props): Props {
  if (props.topic !== undefined || !Array.isArray(props.items)) return props;

  const items = props.items.filter(isRecord);
  const next: Props = { ...props };

  next.topic = String(
    props.title ?? items[0]?.knowledgePoint ?? items[0]?.question ?? '错题诊断',
  ).slice(0, 120);
  next.errorRate = isFiniteNumber(props.errorRate) ? props.errorRate : 100;
  next.mistakeCount = isFiniteNumber(props.mistakeCount) ? props.mistakeCount : props.items.length;

  const itemSummaries = items
    .map((item) => {
      const question = typeof item.question === 'string' ? `【${item.question}】` : '';
      const analysis = typeof item.analysis === 'string' ? item.analysis : '';
      return `${question}${analysis}`;
    })
    .filter((text) => text.length > 0);
  const summary = typeof props.summary === 'string' ? props.summary : '';
  const suggestion =
    typeof props.suggestion === 'string'
      ? props.suggestion
      : [summary, ...itemSummaries].filter(Boolean).join(' ');
  next.suggestion = suggestion.slice(0, 500);

  return next;
}

function normalizePaperDigest(props: Props): Props {
  const next: Props = { ...props };

  if (Array.isArray(props.authors)) {
    const authors = props.authors
      .map((author) => String(author ?? ''))
      .filter((author) => author.length > 0)
      .join(', ')
      .slice(0, 200);
    if (authors.length > 0) next.authors = authors;
  }

  if (next.keyFindings === undefined) {
    const findings = [props.keyIdea, props.method, props.results, props.limitations]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.slice(0, 300));
    if (findings.length > 0) next.keyFindings = findings;
  }

  if (next.abstractExcerpt === undefined) {
    const excerpt = firstText(props.problem, props.abstract, props.summary);
    if (excerpt !== undefined) next.abstractExcerpt = excerpt.slice(0, 500);
  }

  if (next.citationLabel === undefined) {
    const doi = asText(props.doi);
    if (doi !== undefined) next.citationLabel = doi.slice(0, 40);
  }

  return shallowEqualProps(next, props) ? props : next;
}

function normalizeResearchPlan(props: Props): Props {
  if (props.steps !== undefined) return props;

  const source = props.phases ?? props.items ?? props.stages;
  if (!Array.isArray(source)) return props;

  const steps = source.slice(0, 12).map((phase, index): Props => {
    if (!isRecord(phase)) {
      return { label: `阶段 ${index + 1}`, status: index === 0 ? 'active' : 'pending' };
    }
    const goals = Array.isArray(phase.goals) && phase.goals.length > 0
      ? `：${phase.goals.map((goal) => String(goal ?? '')).join('；')}`
      : '';
    const duration = phase.duration ? `（${String(phase.duration)}）` : '';
    const label = [phase.label ?? phase.name ?? phase.title ?? `阶段 ${index + 1}`, duration, goals]
      .join('')
      .slice(0, 200);
    const status = phase.status === 'done' || phase.status === 'active'
      ? phase.status
      : index === 0
        ? 'active'
        : 'pending';
    return { label, status };
  });

  if (steps.length === 0) return props;
  return { ...props, steps };
}

function normalizeResearchReport(props: Props): Props {
  if (props.body !== undefined) return props;

  if (Array.isArray(props.sections)) {
    const body = props.sections
      .map((section) => {
        if (!isRecord(section)) return '';
        const heading = String(section.heading ?? section.title ?? '');
        const content = String(section.content ?? section.body ?? section.text ?? '');
        return `### ${heading}\n\n${content}`;
      })
      .filter((chunk) => chunk.trim().length > 0)
      .join('\n\n')
      .slice(0, 12000);
    if (body.length > 0) return { ...props, body };
    return props;
  }

  const body = firstText(props.content, props.text, props.summary);
  if (body === undefined) return props;
  return { ...props, body: body.slice(0, 12000) };
}

function normalizeBlock(block: GenerativeBlockIntent): GenerativeBlockIntent {
  if (!isRecord(block.props)) return block;

  const props = block.props;
  let next: Props;

  switch (block.type) {
    case 'stat-card':
      next = normalizeStatCard(props);
      break;
    case 'alert':
      next = normalizeAlert(props);
      break;
    case 'list':
      next = normalizeList(props);
      break;
    case 'progress':
      next = normalizeProgress(props);
      break;
    case 'text':
      next = normalizeTextBlock(props);
      break;
    case 'markdown':
      next = normalizeMarkdown(props);
      break;
    case 'key-value-grid':
      next = normalizeKeyValueGrid(props);
      break;
    case 'chart':
      next = normalizeChart(props);
      break;
    case 'steps':
      next = normalizeSteps(props);
      break;
    case 'table':
      next = normalizeTable(props);
      break;
    case 'review-calendar':
      next = normalizeReviewCalendar(props);
      break;
    case 'mistake-analysis':
      next = normalizeMistakeAnalysis(props);
      break;
    case 'paper-digest':
      next = normalizePaperDigest(props);
      break;
    case 'research-plan':
      next = normalizeResearchPlan(props);
      break;
    case 'research-report':
      next = normalizeResearchReport(props);
      break;
    default:
      return block;
  }

  return next === props ? block : { ...block, props: next };
}

// ============================================================================
// 公共入口
// ============================================================================

/**
 * 归一化块列表：别名收敛 + 多卡闪卡展开。
 * 无改动时返回原数组引用；展开后按 `MAX_GENERATIVE_UI_BLOCKS` 截断。
 */
export function normalizeGenerativeBlocks(
  blocks: readonly GenerativeBlockIntent[],
): GenerativeBlockIntent[] {
  const source = blocks as GenerativeBlockIntent[];
  if (!Array.isArray(source) || source.length === 0) return source;

  const output: GenerativeBlockIntent[] = [];
  let changed = false;

  for (const block of source) {
    const expanded = expandFlashcardPreview(block);
    if (expanded.length !== 1 || expanded[0] !== block) changed = true;

    for (const item of expanded) {
      const normalized = normalizeBlock(item);
      if (normalized !== item) changed = true;
      output.push(normalized);
    }
  }

  if (!changed) return source;
  return output.slice(0, MAX_GENERATIVE_UI_BLOCKS);
}
