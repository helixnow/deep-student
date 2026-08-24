/**
 * 模板库浏览 — 纯函数层：类型识别、搜索、筛选、排序。
 * UI 无关，便于单测与复用。
 */
import type { CustomAnkiTemplate } from '@/types';

export type TemplateViewMode = 'grid' | 'list';
export type TemplateTypeFilter = 'all' | 'basic' | 'cloze' | 'other';
export type TemplateSourceFilter = 'all' | 'builtin' | 'custom';
export type TemplateSortOrder = 'updated_desc' | 'created_desc' | 'name_asc' | 'fields_desc';

export type TemplateKind = Exclude<TemplateTypeFilter, 'all'>;

const CLOZE_MARKER = /\{\{\s*cloze:/i;
const CLOZE_FIELD = /\{\{\s*c\d+::/i;

/** 识别模板类型：优先看 note_type，其次看模板代码里的 cloze 语法 */
export function getTemplateKind(template: CustomAnkiTemplate): TemplateKind {
  const noteType = (template.note_type || '').toLowerCase();
  if (noteType.includes('cloze') || noteType.includes('填空')) return 'cloze';
  const code = `${template.front_template || ''}\n${template.back_template || ''}`;
  if (CLOZE_MARKER.test(code) || CLOZE_FIELD.test(code)) return 'cloze';
  if (!noteType || noteType.includes('basic') || noteType.includes('问答')) return 'basic';
  return 'other';
}

export interface TemplateLibraryQuery {
  search: string;
  typeFilter: TemplateTypeFilter;
  sourceFilter: TemplateSourceFilter;
  sortOrder: TemplateSortOrder;
}

export const DEFAULT_LIBRARY_QUERY: TemplateLibraryQuery = {
  search: '',
  typeFilter: 'all',
  sourceFilter: 'all',
  sortOrder: 'updated_desc',
};

export function hasActiveFilters(query: TemplateLibraryQuery): boolean {
  return (
    query.search.trim() !== '' ||
    query.typeFilter !== 'all' ||
    query.sourceFilter !== 'all'
  );
}

function safeTime(value: string | undefined): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function matchesSearch(template: CustomAnkiTemplate, needle: string): boolean {
  if (!needle) return true;
  const haystacks = [
    template.name,
    template.description,
    template.author,
    template.note_type,
    ...(Array.isArray(template.fields) ? template.fields : []),
  ];
  return haystacks.some((value) => (value || '').toLowerCase().includes(needle));
}

export function filterAndSortTemplates(
  templates: CustomAnkiTemplate[],
  query: TemplateLibraryQuery,
): CustomAnkiTemplate[] {
  const needle = query.search.trim().toLowerCase();

  const filtered = templates.filter((template) => {
    if (!matchesSearch(template, needle)) return false;
    if (query.typeFilter !== 'all' && getTemplateKind(template) !== query.typeFilter) return false;
    if (query.sourceFilter === 'builtin' && !template.is_built_in) return false;
    if (query.sourceFilter === 'custom' && template.is_built_in) return false;
    return true;
  });

  const sorted = [...filtered];
  switch (query.sortOrder) {
    case 'name_asc':
      sorted.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
      break;
    case 'created_desc':
      sorted.sort((a, b) => safeTime(b.created_at) - safeTime(a.created_at));
      break;
    case 'fields_desc':
      sorted.sort((a, b) => (b.fields?.length ?? 0) - (a.fields?.length ?? 0));
      break;
    case 'updated_desc':
    default:
      sorted.sort((a, b) => safeTime(b.updated_at) - safeTime(a.updated_at));
      break;
  }
  return sorted;
}

const VIEW_MODE_STORAGE_KEY = 'template-management:view-mode';

export function readStoredViewMode(): TemplateViewMode {
  try {
    const stored = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    return stored === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

export function persistViewMode(mode: TemplateViewMode): void {
  try {
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // localStorage 不可用时静默忽略（视图切换仍然生效，只是不持久化）
  }
}

/* ── 导入失败可读化 ──
 * 后端（serde/fs）与前端 JSON.parse 的原始报错对用户不可读；
 * 按信号词归类为可翻译的失败类别，UI 侧给出「怎么办」级别的文案，
 * 原始报错降级为技术细节附注。纯函数，便于单测。 */

export type TemplateImportErrorKind =
  | 'invalid_json'
  | 'not_template'
  | 'permission'
  | 'unknown';

const IMPORT_PERMISSION_SIGNALS = [
  'permission denied',
  'access denied',
  'forbidden path',
  'not allowed',
];

/** serde 结构校验类报错：JSON 合法但不是模板导出格式 */
const IMPORT_SCHEMA_SIGNALS = [
  'missing field',
  'invalid type',
  'unknown field',
  'duplicate field',
  'invalid value',
];

/** JSON 语法级报错（前端 JSON.parse 与 serde 语法错误的常见措辞） */
const IMPORT_JSON_SYNTAX_SIGNALS = [
  'unexpected token',
  'unexpected end of json',
  'is not valid json',
  'expected value',
  'eof while parsing',
  'trailing characters',
  'key must be a string',
  'control character',
  'invalid json',
  'json parse',
];

export function classifyTemplateImportError(message: string): TemplateImportErrorKind {
  const normalized = message.toLowerCase();
  if (IMPORT_PERMISSION_SIGNALS.some((signal) => normalized.includes(signal))) {
    return 'permission';
  }
  if (IMPORT_SCHEMA_SIGNALS.some((signal) => normalized.includes(signal))) {
    return 'not_template';
  }
  if (IMPORT_JSON_SYNTAX_SIGNALS.some((signal) => normalized.includes(signal))) {
    return 'invalid_json';
  }
  return 'unknown';
}

/** 格式化更新时间为本地短日期；无效日期返回空串 */
export function formatTemplateDate(value: string | undefined, locale?: string): string {
  const time = safeTime(value);
  if (!time) return '';
  try {
    return new Date(time).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return new Date(time).toLocaleDateString();
  }
}
