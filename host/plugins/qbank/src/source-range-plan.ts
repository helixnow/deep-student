/**
 * 超限来源的确定性、无裁剪页范围计划（question_authoring_runner/plan.rs）。
 *
 * 计划只提出页范围并验证并集恰好等于原始页集合；章节边界来自原生文字层，
 * 无法证明安全时标记为需要用户显式选择，绝不自动接受。
 */
export class SourcePlanValidation extends Error {}

export const SOURCE_RANGE_PLAN_SCHEMA_VERSION = 1;
export const SOURCE_RANGE_PLAN_REQUIRED_CODE = 'SOURCE_RANGE_PLAN_REQUIRED';

export type SourceLimitReason = 'context_window' | 'image_count' | 'request_size';

export interface SourcePage {
  source_id: string;
  page: number;
  blob_hash: string;
  width: number;
  height: number;
  text_hint: string | null;
}

export interface SourceBundle {
  sources: Record<string, unknown>[];
  pages: SourcePage[];
  text: string;
  format: string;
}

export interface ChapterBoundary { source_id: string; page: number; label: string }

export interface PlannedRange {
  source_id: string;
  start_page: number;
  end_page: number;
  page_count: number;
  starts_at_chapter: boolean;
  ends_at_chapter: boolean;
  chapter_labels: string[];
  dependency_safe: boolean;
  estimated_input_tokens: number;
}

export interface SourceRangePlan {
  schema_version: number;
  reason: SourceLimitReason;
  total_pages: number;
  ranges: PlannedRange[];
  chapter_boundaries: ChapterBoundary[];
  automatic: boolean;
  requires_user_selection: boolean;
  one_request_policy: boolean;
  warnings: string[];
}

export interface RangePlanOptions {
  max_pages_per_range: number;
  max_estimated_tokens_per_range: number | null;
}

export function defaultRangePlanOptions(): RangePlanOptions {
  return { max_pages_per_range: 20, max_estimated_tokens_per_range: null };
}

export function afterProviderLimitOptions(config: {
  context_window?: number | null;
  max_output_tokens: number;
}): RangePlanOptions {
  let budget: number | null = null;
  if (config.context_window !== null && config.context_window !== undefined) {
    const window = config.context_window;
    const output = config.max_output_tokens;
    const base = window >= output ? window - output : 0;
    budget = Math.floor(base * 4 / 5);
  }
  return {
    max_pages_per_range: 20,
    max_estimated_tokens_per_range: budget !== null && budget > 0 ? budget : null,
  };
}

export function limitReasonCode(reason: SourceLimitReason): string {
  return reason === 'context_window' ? 'CONTEXT_LIMIT'
    : reason === 'image_count' ? 'PROVIDER_IMAGE_LIMIT' : 'PROVIDER_REQUEST_SIZE_LIMIT';
}

export function limitReasonDescription(reason: SourceLimitReason): string {
  return reason === 'context_window' ? '模型上下文窗口无法容纳完整来源'
    : reason === 'image_count' ? '供应商单次请求图片数量受限' : '供应商单次请求体大小受限';
}

const CONTEXT_WINDOW_NEEDLES = [
  'context length', 'context_length', 'maximum context', 'max context', 'too many tokens',
  'exceeds the maximum', 'exceed the maximum', 'prompt is too long', 'input is too long',
  'reduce the length', 'maximum number of tokens', 'context window', '上下文长度', '超出最大',
];
const IMAGE_LIMIT_NEEDLES = [
  'too many images', 'maximum number of images', 'max images', 'image count',
  'images per request', 'image limit', '图片数量', '图片过多', '图片超出',
];
const REQUEST_SIZE_NEEDLES = [
  'request too large', 'payload too large', 'request entity too large', 'body too large',
  'content too large', 'request size',
];

export function providerBodyIndicatesContextWindow(body: string): boolean {
  const lower = body.toLowerCase();
  return CONTEXT_WINDOW_NEEDLES.some(needle => lower.includes(needle));
}

export function detectProviderLimit(error: {
  message: string;
  details: unknown;
}): SourceLimitReason | null {
  const details = error.details !== null && typeof error.details === 'object' && !Array.isArray(error.details)
    ? error.details as Record<string, unknown> : null;
  if (details?.llm_error_code === 'CONTEXT_WINDOW_EXCEEDED') return 'context_window';
  const rawStatus = details?.status;
  const status = typeof rawStatus === 'number' && Number.isInteger(rawStatus) && rawStatus >= 0
    ? rawStatus : null;
  const rawBody = details?.body;
  const body = rawBody === undefined || rawBody === null ? ''
    : typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);
  const haystack = `${error.message} ${body} ${details === null ? '' : JSON.stringify(details)}`.toLowerCase();
  if (providerBodyIndicatesContextWindow(haystack)) return 'context_window';
  if (status === null || status === 400 || status === 413 || status === 422) {
    if (IMAGE_LIMIT_NEEDLES.some(needle => haystack.includes(needle))) return 'image_count';
    if (status === 413 || REQUEST_SIZE_NEEDLES.some(needle => haystack.includes(needle))) {
      return 'request_size';
    }
  }
  return null;
}

function pageKey(sourceId: string, page: number): string {
  return `${sourceId}\u0000${page}`;
}

function chars(text: string): string[] {
  return Array.from(text);
}

function firstLine(text: string): string | null {
  for (const line of text.split('\n')) {
    if (line.trim() !== '') return line;
  }
  return null;
}

function detectChapterHeading(text: string): string | null {
  const first = firstLine(text);
  if (first === null) return null;
  const trimmed = first.trim();
  if (trimmed === '' || chars(trimmed).length > 80) return null;
  const plain = trimmed.replace(/^#+/, '').trim();
  if (trimmed.startsWith('#') && plain !== '' && chars(plain).length <= 60) return plain;
  const lower = plain.toLowerCase();
  if (plain.startsWith('第')) {
    const head = chars(plain).slice(0, 16).join('');
    if (['章', '节', '单元', '部分', '篇'].some(marker => head.includes(marker))) return plain;
  }
  const chineseNumber = '一二三四五六七八九十百零〇';
  if (plain.length > 0 && chineseNumber.includes(plain[0]!) && plain.includes('、')
    && ['选择', '填空', '判断', '阅读', '解答', '作文', '答案', '解析', '练习', '综合']
      .some(word => plain.includes(word))) {
    return plain;
  }
  if (lower.startsWith('chapter') || lower.startsWith('section') || lower.startsWith('part ')
    || lower.startsWith('unit ') || lower.startsWith('answer key') || lower.startsWith('solutions')) {
    return plain;
  }
  if (['参考答案', '答案', '解析', '试题解析'].some(heading => plain.startsWith(heading))) return plain;
  return null;
}

function isAnswerSection(label: string): boolean {
  const lower = label.toLowerCase();
  return ['答案', '解析', 'answer key', 'answers', 'solutions'].some(needle => lower.includes(needle));
}

function startsWithContinuation(text: string): boolean {
  const first = (firstLine(text) ?? '').trim().toLowerCase();
  return ['（续）', '(续)', '续表', '接上页', '续上页', 'continued', '续：']
    .some(needle => first.includes(needle));
}

function endsWithForwardReference(text: string): boolean {
  const tail = chars(text).slice(-240).join('').toLowerCase();
  return ['如下图', '见下图', '如下表', '见下表', '见下文', '阅读下面', '根据材料', '完成下题',
    '见下页', '见下一页', 'see below', 'shown below'].some(needle => tail.includes(needle));
}

function estimatePageTokens(text: string): number {
  return Math.floor(chars(text).length / 3) + 1600;
}

interface Segment {
  source_id: string;
  start: number;
  end: number;
  labels: string[];
  starts_safe: boolean;
  ends_safe: boolean;
  forced_split: boolean;
  estimated_tokens: number;
}

function segmentLength(segment: Segment): number {
  return segment.end - segment.start + 1;
}

function buildSegments(sourceId: string, pages: number[], pageText: Map<string, string>,
  warnings: string[]): Segment[] {
  const segments: Segment[] = [];
  let current: Segment | null = null;
  for (const [index, page] of pages.entries()) {
    const text = pageText.get(pageKey(sourceId, page)) ?? '';
    const label = detectChapterHeading(text);
    const continuation = startsWithContinuation(text);
    const previousForward = index > 0
      && endsWithForwardReference(pageText.get(pageKey(sourceId, pages[index - 1]!)) ?? '');
    const startsSafe = index === 0 || (label !== null && !continuation && !previousForward);
    const beginsNewSegment = index === 0 || (label !== null && !continuation);
    if (beginsNewSegment) {
      if (current !== null) segments.push(current);
      if (index > 0 && !startsSafe) {
        warnings.push(`${sourceId} 第 ${page} 页的章节边界存在续页/跨页引用，未被证明安全`);
      }
      current = {
        source_id: sourceId, start: page, end: page, labels: label === null ? [] : [label],
        starts_safe: startsSafe, ends_safe: false, forced_split: false,
        estimated_tokens: estimatePageTokens(text),
      };
    } else if (current !== null) {
      current.end = page;
      current.estimated_tokens += estimatePageTokens(text);
      if (label !== null) current.labels.push(label);
    }
  }
  if (current !== null) segments.push(current);
  for (let index = 0; index < segments.length; index += 1) {
    const next = segments[index + 1];
    segments[index]!.ends_safe = next === undefined || next.starts_safe;
  }
  return segments;
}

function estimateRangeTokens(sourceId: string, start: number, end: number,
  pageText: Map<string, string>): number {
  let total = 0;
  for (let page = start; page <= end; page += 1) {
    total += estimatePageTokens(pageText.get(pageKey(sourceId, page)) ?? '');
  }
  return total;
}

function equalPageSets(left: Map<string, Set<number>>, right: Map<string, Set<number>>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    const other = right.get(key);
    if (other === undefined || other.size !== value.size) return false;
    for (const page of value) if (!other.has(page)) return false;
  }
  return true;
}

export function validatePlan(plan: SourceRangePlan, bundle: SourceBundle): void {
  if (plan.schema_version !== SOURCE_RANGE_PLAN_SCHEMA_VERSION) {
    throw new SourcePlanValidation('范围计划版本不受支持');
  }
  const expected = new Map<string, Set<number>>();
  for (const page of bundle.pages) {
    const set = expected.get(page.source_id) ?? new Set<number>();
    set.add(page.page);
    expected.set(page.source_id, set);
  }
  const seen = new Map<string, Set<number>>();
  for (const range of plan.ranges) {
    if (range.start_page === 0 || range.end_page < range.start_page) {
      throw new SourcePlanValidation('范围计划包含无效页码');
    }
    const set = seen.get(range.source_id) ?? new Set<number>();
    for (let page = range.start_page; page <= range.end_page; page += 1) {
      if (set.has(page)) {
        throw new SourcePlanValidation(`范围计划重复声明 ${range.source_id} 第 ${page} 页`);
      }
      set.add(page);
    }
    seen.set(range.source_id, set);
  }
  if (!equalPageSets(seen, expected)) {
    throw new SourcePlanValidation('范围计划未精确覆盖全部原始页（存在跳过或缺失），不能自动接受');
  }
}

export function planSourceRanges(bundle: SourceBundle, reason: SourceLimitReason,
  options: RangePlanOptions): SourceRangePlan {
  if (bundle.sources.some(source => Object.hasOwn(source, 'selection'))) {
    throw new SourcePlanValidation('范围计划必须基于完整原始来源生成，不能基于已裁剪范围再次规划');
  }
  if (bundle.pages.length === 0) {
    throw new SourcePlanValidation(
      '来源没有可核验的分页边界，无法制定无页跳过范围计划；请整份提供或改用支持更长输入的模型');
  }
  if (options.max_pages_per_range === 0) {
    throw new SourcePlanValidation('范围计划单批页数必须为正数');
  }

  const warnings: string[] = [];
  const chapterBoundaries: ChapterBoundary[] = [];
  const pageText = new Map<string, string>();
  const pagesBySource = new Map<string, number[]>();
  for (const page of bundle.pages) {
    const pages = pagesBySource.get(page.source_id) ?? [];
    if (pages.includes(page.page)) {
      throw new SourcePlanValidation(
        `来源 ${page.source_id} 第 ${page.page} 页重复，无法制定可核验范围计划`);
    }
    pages.push(page.page);
    pagesBySource.set(page.source_id, pages);
    pageText.set(pageKey(page.source_id, page.page), page.text_hint ?? '');
  }
  for (const pages of pagesBySource.values()) pages.sort((left, right) => left - right);

  const sourceIds = [...pagesBySource.keys()].sort();
  const hasUnpagedSource = bundle.sources.some(source => source.page_count == null
    && typeof source.source_id === 'string' && !pagesBySource.has(source.source_id));
  if (hasUnpagedSource) {
    warnings.push('存在无分页正文来源，无法按页边界确定性拆分；只能整份提供或由用户明确选择');
  }

  let hasAnswerSection = false;
  let hasMissingNativeText = false;
  for (const sourceId of sourceIds) {
    const pages = pagesBySource.get(sourceId)!;
    for (const [index, pageNo] of pages.entries()) {
      const text = pageText.get(pageKey(sourceId, pageNo)) ?? '';
      if (text.trim() === '') hasMissingNativeText = true;
      const label = detectChapterHeading(text);
      if (label !== null) {
        if (isAnswerSection(label)) hasAnswerSection = true;
        chapterBoundaries.push({ source_id: sourceId, page: pageNo, label });
      }
      if (index > 0 && endsWithForwardReference(pageText.get(pageKey(sourceId, pages[index - 1]!)) ?? '')
        && startsWithContinuation(text)) {
        warnings.push(`${sourceId} 第 ${pages[index - 1]}→${pageNo} 页存在跨页引用标记，章节边界未被证明安全`);
      }
    }
  }
  if (hasMissingNativeText) {
    warnings.push('部分页没有原生文字层，无法用正文确定章节边界；需用户核对页范围');
  }
  if (hasAnswerSection) {
    warnings.push('检测到独立答案/解析区，无法证明每题与答案页的完整依赖；不能自动接受分批');
  }

  const maxPages = options.max_pages_per_range;
  const budget = options.max_estimated_tokens_per_range;
  const ranges: Segment[] = [];
  for (const sourceId of sourceIds) {
    const pages = pagesBySource.get(sourceId)!;
    const segments = buildSegments(sourceId, pages, pageText, warnings);
    const chunks: Segment[] = [];
    for (const segment of segments) {
      if (segmentLength(segment) > maxPages
        || (budget !== null && segment.estimated_tokens > budget)) {
        warnings.push(`${sourceId} 第 ${segment.start}–${segment.end} 页的章节超过单批预算，`
          + '只能在页边界强制切分；题组/材料/答案依赖未被证明安全');
        let chunkStart = segment.start;
        while (chunkStart <= segment.end) {
          let chunkEnd = chunkStart;
          let chunkTokens = 0;
          while (chunkEnd <= segment.end && chunkEnd - chunkStart <= maxPages - 1) {
            const pageTokens = estimatePageTokens(pageText.get(pageKey(sourceId, chunkEnd)) ?? '');
            if (chunkEnd > chunkStart && budget !== null && chunkTokens + pageTokens > budget) break;
            chunkTokens += pageTokens;
            chunkEnd += 1;
          }
          const end = chunkEnd - 1;
          if (end < chunkStart) break;
          chunks.push({
            source_id: sourceId, start: chunkStart, end,
            labels: [...segment.labels], starts_safe: chunkStart === segment.start && segment.starts_safe,
            ends_safe: end === segment.end && segment.ends_safe, forced_split: true,
            estimated_tokens: estimateRangeTokens(sourceId, chunkStart, end, pageText),
          });
          if (end >= segment.end) break;
          chunkStart = end + 1;
        }
      } else {
        chunks.push(segment);
      }
    }

    let current: Segment | null = null;
    for (const chunk of chunks) {
      const fits = current !== null && segmentLength(current) + segmentLength(chunk) <= maxPages
        && (budget === null || current.estimated_tokens + chunk.estimated_tokens <= budget);
      if (fits && current !== null) {
        current.end = chunk.end;
        current.labels.push(...chunk.labels);
        current.forced_split = current.forced_split || chunk.forced_split;
        current.estimated_tokens += chunk.estimated_tokens;
        current.ends_safe = chunk.ends_safe;
      } else {
        if (current !== null) ranges.push(current);
        current = { ...chunk, labels: [...chunk.labels] };
      }
    }
    if (current !== null) ranges.push(current);
  }

  ranges.sort((left, right) => left.source_id < right.source_id ? -1
    : left.source_id > right.source_id ? 1 : left.start - right.start);
  const globalSafe = !hasUnpagedSource && !hasAnswerSection && !hasMissingNativeText
    && ranges.every(range => range.starts_safe && !range.forced_split);
  const plan: SourceRangePlan = {
    schema_version: SOURCE_RANGE_PLAN_SCHEMA_VERSION,
    reason,
    total_pages: bundle.pages.length,
    ranges: ranges.map(range => ({
      source_id: range.source_id, start_page: range.start, end_page: range.end,
      page_count: segmentLength(range), starts_at_chapter: range.starts_safe,
      ends_at_chapter: range.ends_safe, chapter_labels: range.labels,
      dependency_safe: range.starts_safe && !range.forced_split && globalSafe,
      estimated_input_tokens: range.estimated_tokens,
    })),
    chapter_boundaries: chapterBoundaries,
    automatic: globalSafe,
    requires_user_selection: !globalSafe,
    one_request_policy: bundle.pages.length <= 20,
    warnings,
  };
  validatePlan(plan, bundle);
  return plan;
}

export function planAfterProviderLimit(bundle: SourceBundle, reason: SourceLimitReason,
  config: { context_window?: number | null; max_output_tokens: number }): SourceRangePlan {
  return planSourceRanges(bundle, reason, afterProviderLimitOptions(config));
}

export function rangePlanRequiredError(error: { error_type: string; message: string; details: unknown },
  plan: SourceRangePlan): { error_type: string; message: string; details: unknown } {
  // plan.rs:490-510：details 为 None 时取 `{}`；只有对象才插入字段，非对象 details 原样保留。
  const base = error.details === null || error.details === undefined ? {} : error.details;
  const isObject = base !== null && typeof base === 'object' && !Array.isArray(base);
  const details: unknown = !isObject ? base : {
    ...(base as Record<string, unknown>),
    code: SOURCE_RANGE_PLAN_REQUIRED_CODE,
    reason: limitReasonCode(plan.reason),
    reason_description: limitReasonDescription(plan.reason),
    source_route: 'provider_limit_range_plan',
    complete_document: false,
    no_pages_skipped: true,
    requires_user_selection: plan.requires_user_selection,
    plan,
    provider_error: error.message,
  };
  return {
    error_type: error.error_type,
    message: `${limitReasonDescription(plan.reason)}。完整来源未被自动拆分、未跳过任何页，`
      + '也未创建正式题目；请选择完整证据范围后重试',
    details,
  };
}
