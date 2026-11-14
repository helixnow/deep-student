import { rustTrim, utf8ByteLength } from '../../../platform/util/portable.ts';
import type { ChunkingConfig, IndexableResourceType, IndexingConfig, PageText, SearchConfig, TextChunk } from '../api.ts';

export function defaultChunkingConfig(): ChunkingConfig { return { strategy: 'fixed_size', chunkSize: 512, chunkOverlap: 50, minChunkSize: 20 }; }
export function defaultIndexingConfig(): IndexingConfig { return { enabled: true, batchSize: 10, intervalSecs: 5, maxConcurrent: 2, retryDelaySecs: 60, maxRetries: 3 }; }
export function defaultSearchConfig(): SearchConfig { return { defaultTopK: 10, enableHybrid: true, enableReranking: false }; }
function isCommonTextChar(c: string): boolean {
  return /[\x21-\x7e\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3000-\u303f\uff01-\uff5e\u3040-\u30ff\uac00-\ud7af\u00c0-\u024f]/u.test(c)
    || /\p{White_Space}/u.test(c) || '，。；：！？“”‘’（）【】《》、…—～·「」『』〈〉'.includes(c);
}
export function isTextQualityAcceptable(text: string): boolean {
  const chars = Array.from(text);
  if (!chars.length) return false;
  let common = 0, replacement = 0, control = 0;
  for (const c of chars) {
    if (c === '\ufffd') replacement++;
    else if (/\p{Cc}/u.test(c) && !/\p{White_Space}/u.test(c)) control++;
    else if (isCommonTextChar(c)) common++;
  }
  return replacement / chars.length <= .05 && control / chars.length <= .1 && common / chars.length >= .4;
}
function textChunk(index: number, text: string, start: number, end: number): TextChunk {
  return { index, text, start_pos: start | 0, end_pos: end | 0, page_index: null, source_id: null };
}
function chunkFixedSize(text: string, config: ChunkingConfig): TextChunk[] {
  const chars = Array.from(text), total = chars.length, chunks: TextChunk[] = [];
  if (total === 0) return chunks;
  if (total <= config.chunkSize) return [textChunk(0, text, 0, total)];
  let start = 0;
  while (start < total) {
    const end = Math.min(start + config.chunkSize, total), text = chars.slice(start, end).join('');
    if (utf8ByteLength(text) >= config.minChunkSize) chunks.push(textChunk(chunks.length, text, start, end));
    if (end >= total) break;
    start = Math.max(0, end - config.chunkOverlap);
    if (start >= end) start = end;
  }
  return chunks;
}
function chunkSemantic(text: string, config: ChunkingConfig): TextChunk[] {
  const chunks: TextChunk[] = [];
  let current = '', start = 0, pos = 0;
  for (const para of text.split('\n\n')) {
    const size = utf8ByteLength(para);
    if (utf8ByteLength(current) + size + 2 > config.chunkSize && current.length) {
      if (utf8ByteLength(current) >= config.minChunkSize) chunks.push(textChunk(chunks.length, rustTrim(current), start, pos));
      current = ''; start = pos;
    }
    if (current.length) current += '\n\n';
    current += para; pos += size + 2;
  }
  if (utf8ByteLength(current) >= config.minChunkSize) chunks.push(textChunk(chunks.length, rustTrim(current), start, pos));
  return chunks.length === 0 && text.length > 0 ? chunkFixedSize(text, config) : chunks;
}
export function chunkText(text: string, config = defaultChunkingConfig()): TextChunk[] {
  const original = config.strategy === 'semantic' ? chunkSemantic(text, config) : chunkFixedSize(text, config);
  const chunks = original.filter(c => isTextQualityAcceptable(c.text));
  if (chunks.length < original.length) chunks.forEach((c, i) => { c.index = i; });
  return chunks;
}
export function chunkTextWithPages(pages: readonly PageText[], config = defaultChunkingConfig()): TextChunk[] {
  const result: TextChunk[] = [];
  for (const page of pages) for (const c of chunkText(page.text, config)) {
    result.push({ ...c, index: result.length, page_index: page.page_index, source_id: page.source_id });
  }
  return result;
}
export function shouldDisableIndexForMissingNote(resource: { data: string | null }): boolean { return !rustTrim(resource.data ?? '').length; }
export function searchExecutionBackend(_legacyEnableCrossDimension: boolean): 'unified_profile_planner' { return 'unified_profile_planner'; }
export function normalizeCompatibilityRrfScore(score: number, best: number): number {
  return !Number.isFinite(score) || !Number.isFinite(best) || best <= 0 ? 0 : Math.min(1, Math.max(0, score / best));
}
function parse(data: string): unknown {
  try { return JSON.parse(data) as unknown; } catch { return null; }
}
function field(value: unknown, key: string): unknown { return value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined; }
function str(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
function array(value: unknown): unknown[] | undefined { return Array.isArray(value) ? value : undefined; }
function cards(page: unknown): unknown[] { return array(field(page, 'cards')) ?? array(field(page, 'questions')) ?? []; }
function cardTexts(card: unknown, includeExtras: boolean): string[] {
  const texts: string[] = [];
  const add = (label: string, value: unknown) => { const s = str(value); if (s != null && rustTrim(s)) texts.push(`${label}: ${rustTrim(s)}`); };
  add('题目', str(field(card, 'ocr_text')) ?? str(field(card, 'text')));
  if (includeExtras) {
    const tags = (array(field(card, 'tags')) ?? []).filter((t): t is string => typeof t === 'string');
    if (tags.length) texts.push(`标签: ${tags.join(', ')}`);
  }
  add('答案', field(card, 'answer'));
  add('解析', field(card, 'explanation'));
  if (includeExtras) add('笔记', field(card, 'user_note'));
  return texts;
}
export function extractIndexablePages(type: IndexableResourceType, resourceId: string, data: string): PageText[] | null {
  if (type !== 'exam' && type !== 'textbook') return null;
  const pages = array(field(parse(data), 'pages'));
  if (!pages) return null;
  const result: PageText[] = [];
  pages.forEach((page, index) => {
    if (type === 'exam') {
      const texts = cards(page).flatMap(c => cardTexts(c, false));
      if (texts.length) result.push({ page_index: index | 0, text: texts.join('\n\n'), source_id: resourceId });
    } else {
      const pi = field(page, 'page_index');
      const pageIndex = typeof pi === 'number' && Number.isInteger(pi) && pi >= -9223372036854775808 && pi < 9223372036854775808 ? pi : index;
      // serde Value::get returns Some(Null), so null stops the fallback chain.
      const fields = ['text', 'content', 'extracted_text'];
      const value = fields.map(k => field(page, k)).find(v => v !== undefined);
      const text = str(value) ?? '';
      if (rustTrim(text)) result.push({ page_index: pageIndex | 0, text, source_id: resourceId });
    }
  });
  return result.length ? result : null;
}
function extractMarkdownText(content: string): string {
  const patterns: [RegExp, string][] = [
    [/!\[.*?\]\(.*?\)/g, ''], [/\[([^\]]+)\]\([^\)]+\)/g, '$1'], [/```[\s\S]*?```/g, ''], [/`[^`]+`/g, ''],
    [/^#{1,6}\p{White_Space}+/gu, ''], [/\*\*([^*]+)\*\*/g, '$1'], [/\*([^*]+)\*/g, '$1'],
    [/__([^_]+)__/g, '$1'], [/_([^_]+)_/g, '$1'], [/~~([^~]+)~~/g, '$1'], [/^>\p{White_Space}+/gu, ''],
    [/^[-*+]\p{White_Space}+/gu, ''], [/^\p{Nd}+\.\p{White_Space}+/gu, ''], [/^---+$(?![\s\S])/g, ''], [/^\|.*\|$(?![\s\S])/g, ''],
  ];
  for (const [pattern, replacement] of patterns) content = content.replace(pattern, replacement);
  return content.split(/\r?\n/).map(rustTrim).filter(s => s.length).join('\n');
}
export function extractMindmapText(data: string): string | null {
  const root = field(parse(data), 'root'), texts: string[] = [];
  function visit(node: unknown, path: string[], depth: number): void {
    const text = rustTrim(str(field(node, 'text')) ?? '');
    if (text) {
      texts.push(path.length ? `【${path.join(' > ')}】 > ${text}` : `【${text}】`);
      const note = rustTrim(str(field(node, 'note')) ?? '');
      if (note) texts.push(`  备注: ${note}`);
    }
    if (depth < 50) for (const child of array(field(node, 'children')) ?? []) visit(child, text ? [...path, text] : path, depth + 1);
  }
  if (root !== undefined) visit(root, [], 0);
  return texts.length ? texts.join('\n') : null;
}
export function extractIndexableContent(type: IndexableResourceType, data: string): string | null {
  switch (type) {
    case 'note': case 'insight_card': return extractMarkdownText(data);
    case 'translation': {
      const json = parse(data), source = str(field(json, 'source')) ?? '', translated = str(field(json, 'translated')) ?? '';
      return source.length || translated.length ? `${source}\n\n${translated}` : null;
    }
    case 'exam': {
      const texts = (array(field(parse(data), 'pages')) ?? []).flatMap(p => cards(p).flatMap(c => cardTexts(c, true)));
      return texts.length ? texts.join('\n\n') : null;
    }
    case 'textbook': {
      if (rustTrim(data)) return data;
      const text = str(field(parse(data), 'extracted_text'));
      return text?.length ? text : null;
    }
    case 'essay': return data;
    case 'file': return data.startsWith('{') ? str(field(parse(data), 'extracted_text')) ?? null : null;
    case 'mindmap': return extractMindmapText(data);
    case 'image': case 'retrieval': return null;
  }
}
