/**
 * `question_authoring_runner.rs`：`SourceBundle::scoped`（285-436）、`extract_source_text_segment`（438-447）、
 * `validate_source_refs`（874-917，抽取路径的来源定位校验）。
 */
import { AppError } from '../../../platform/errors/api.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';
import type { SourceRange } from '../api.ts';
import { QbankServiceError } from './question-service.ts';
import { isRustBlank } from './source-bundle-identity.ts';
import { asU64, coverageKey, expectedCoverage, isScoped, type SourceBundle } from './source-bundle.ts';

type JsonObject = { [key: string]: JsonValue };

function validation(message: string): never {
  throw new QbankServiceError(AppError.validation(message));
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
}

/** `value["key"]`：非对象或缺失 → Null。 */
function index(value: JsonValue | undefined, key: string): JsonValue {
  return isObject(value) && Object.hasOwn(value, key) ? value[key]! : null;
}

/** `extract_source_text_segment`。 */
function extractSourceTextSegment(text: string, sourceId: string, bundled: boolean): string | null {
  if (!bundled) return isRustBlank(text) ? null : text;
  const start = text.indexOf(`<source id="${sourceId}"`);
  if (start === -1) return null;
  const gt = text.indexOf('>', start);
  if (gt === -1) return null;
  const openEnd = gt + 1;
  const close = text.indexOf('</source>', openEnd);
  if (close === -1) return null;
  return text.slice(openEnd, close);
}

function trimNewlines(value: string): string {
  return value.replace(/^\n+|\n+$/g, '');
}

/** `SourceBundle::scoped`：按显式原始页范围生成不可变子集；范围内无损，范围外来源保留为溯源记录。 */
export function scopedBundle(bundle: SourceBundle, ranges: readonly SourceRange[]): SourceBundle {
  if (isScoped(bundle)) validation('已裁剪的来源不能再次选择范围，请从完整原始来源重新选择');
  if (ranges.length === 0) validation('未选择任何原始来源范围');
  const selectedPages = new Set<string>();
  const wholeSources = new Set<string>();
  const rangesBySource = new Map<string, [number, number][]>();
  for (const range of ranges) {
    const source = bundle.sources.find(item => index(item, 'source_id') === range.source_id);
    if (source === undefined) validation(`范围引用了不存在的来源: ${range.source_id}`);
    const pageCount = asU64(index(source, 'page_count'));
    const start = range.start_page ?? null;
    const end = range.end_page ?? null;
    if (pageCount !== null && start !== null && end !== null) {
      if (start === 0 || end < start || end > pageCount) {
        validation(`来源 ${range.source_id} 的页码范围 ${start}-${end} 无效（原始共 ${pageCount} 页）`);
      }
      for (let page = start; page <= end; page += 1) {
        const key = coverageKey(range.source_id, page);
        if (selectedPages.has(key)) validation(`来源 ${range.source_id} 第 ${page} 页被重复选择`);
        selectedPages.add(key);
      }
      const list = rangesBySource.get(range.source_id) ?? [];
      list.push([start, end]);
      rangesBySource.set(range.source_id, list);
    } else if (pageCount !== null) {
      validation(`分页来源 ${range.source_id} 必须给出闭区间页码`);
    } else if (start === null && end === null) {
      if (wholeSources.has(range.source_id)) validation(`来源 ${range.source_id} 被重复选择`);
      wholeSources.add(range.source_id);
    } else {
      validation(`无分页来源 ${range.source_id} 只能整份选择`);
    }
  }
  if (selectedPages.size === 0 && wholeSources.size === 0) validation('所选范围为空');

  const pages = bundle.pages.filter(page => selectedPages.has(coverageKey(page.source_id, page.page)))
    .map(page => ({ ...page }));
  if (pages.length !== selectedPages.size) validation('所选原始页在来源中不存在（页图缺失），不能伪造处理覆盖');

  const bundled = bundle.format === 'bundle';
  let text = '';
  const sources: JsonObject[] = [];
  for (const source of bundle.sources) {
    const id = index(source, 'source_id');
    if (typeof id !== 'string') continue;
    const entry: JsonObject = structuredClone(source);
    entry.source_route = 'original_scoped_range';
    const pageCount = asU64(index(source, 'page_count'));
    if (pageCount !== null) {
      const selected = rangesBySource.get(id) ?? [];
      const selectedCount = selected.reduce((sum, [start, end]) => sum + (end - start + 1), 0);
      entry.selection = {
        ranges: selected.map(([start, end]) => ({ start_page: start, end_page: end })),
        original_page_count: pageCount,
        selected_page_count: selectedCount,
        complete_source: selectedCount === pageCount,
      };
    } else if (wholeSources.has(id)) {
      entry.selection = {
        ranges: [], original_page_count: null, selected_page_count: null, selected_whole: true,
        complete_source: true,
      };
      if (!isRustBlank(bundle.text)) {
        const segment = extractSourceTextSegment(bundle.text, id, bundled);
        if (segment === null) validation(`无法无损截取来源 ${id} 的正文，请整份重新解析`);
        text += bundled ? `\n\n<source id="${id}">\n${trimNewlines(segment)}\n</source>\n` : segment;
      }
    } else {
      entry.selection = {
        ranges: [], original_page_count: null, selected_page_count: 0, selected_whole: false,
        complete_source: false,
      };
    }
    sources.push(entry);
  }
  const scoped: SourceBundle = { sources, pages, text, format: bundle.format };
  if (expectedCoverage(scoped).size === 0) validation('所选范围没有可提供的来源内容');
  return scoped;
}

function nonEmptyArray(value: JsonValue): boolean {
  return Array.isArray(value) && value.length > 0;
}

/** `validate_source_refs`：每项须有来源定位、所有引用都在本次提供的页内；抽取题答案须有来源。 */
export function validateSourceRefs(raw: JsonValue, bundle: SourceBundle): void {
  const expected = expectedCoverage(bundle);
  const questions = index(raw, 'questions');
  const materials = index(raw, 'materials');
  const items = [...(Array.isArray(questions) ? questions : []), ...(Array.isArray(materials) ? materials : [])];
  for (const item of items) {
    if (!nonEmptyArray(index(item, 'source_refs'))) validation('抽取内容缺少原始来源定位，未创建正式题目');
    for (const field of ['source_refs', 'answer_source_refs', 'figures']) {
      const refs = index(item, field);
      for (const reference of Array.isArray(refs) ? refs : []) {
        const sourceId = index(reference, 'source_id');
        const key = coverageKey(typeof sourceId === 'string' ? sourceId : '', asU64(index(reference, 'page')));
        if (!expected.has(key)) validation(`${field} 引用了未提供的来源或页码`);
      }
    }
    const answer = isObject(item) && Object.hasOwn(item, 'answer') ? item.answer! : undefined;
    if (index(raw, 'mode') === 'extract' && answer !== undefined && answer !== null && answer !== '') {
      if (index(item, 'answer_origin') !== 'source' || !nonEmptyArray(index(item, 'answer_source_refs'))) {
        validation('抽取题的答案缺少明确来源，禁止自动解题填充答案');
      }
    }
  }
}
