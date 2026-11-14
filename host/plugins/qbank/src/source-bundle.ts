/**
 * `question_authoring_runner.rs` 中出题/抽取共用的来源证据结构与校验
 * （SourcePage / SourceBundle 方法 / validate_coverage / validate_visual_evidence）。
 *
 * 页图字节由调用方注入的 `loadPageImageBytes` 读取（Rust
 * `page_rasterizer::load_page_image_bytes`，按 blob_hash 读 VFS blob）。
 * Rust 依赖 serde_json preserve_order，JSON.stringify 的插入序与之相同。
 */
import { toBase64 } from '../../../platform/crypto/encoding.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';
import { QbankServiceError } from './question-service.ts';

type JsonObject = { [key: string]: JsonValue };

export interface SourcePage {
  source_id: string;
  page: number;
  blob_hash: string;
  width: number;
  height: number;
  text_hint: string | null;
}

export interface SourceBundle {
  sources: JsonObject[];
  pages: SourcePage[];
  text: string;
  format: string;
}

/** HashSet<(String, Option<u64>)> 的键。 */
export type CoverageKey = string;
export function coverageKey(sourceId: string, page: number | null): CoverageKey {
  return `${sourceId}\u0000${page === null ? '' : String(page)}`;
}

function validation(message: string): never {
  throw new QbankServiceError(AppError.validation(message));
}

/** serde `as_u64`：只接受非负整数。 */
export function asU64(value: JsonValue | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function field(value: JsonValue | undefined, key: string): JsonValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value[key] : undefined;
}

function asStr(value: JsonValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function isNullish(value: JsonValue | undefined): boolean {
  return value === undefined || value === null;
}

export function isScoped(bundle: SourceBundle): boolean {
  return bundle.sources.some(source => Object.hasOwn(source, 'selection'));
}

export function promptSources(bundle: SourceBundle): JsonObject[] {
  return bundle.sources.filter(source => {
    if (!Object.hasOwn(source, 'selection')) return true;
    const selection = source.selection;
    return isNullish(source.page_count)
      ? field(selection, 'selected_whole') === true
      : (asU64(field(selection, 'selected_page_count')) ?? 0) > 0;
  });
}

export function expectedCoverage(bundle: SourceBundle): Set<CoverageKey> {
  const expected = new Set(bundle.pages.map(page => coverageKey(page.source_id, page.page)));
  for (const source of bundle.sources) {
    if (!isNullish(source.page_count)) continue;
    const selected = !Object.hasOwn(source, 'selection') || field(source.selection, 'selected_whole') === true;
    const id = asStr(source.source_id);
    if (selected && id !== null) expected.add(coverageKey(id, null));
  }
  return expected;
}

export function originalCoverage(bundle: SourceBundle): Set<CoverageKey> {
  const original = new Set<CoverageKey>();
  for (const source of bundle.sources) {
    const id = asStr(source.source_id);
    if (id === null) continue;
    const count = asU64(source.page_count);
    if (count !== null) {
      for (let page = 1; page <= count; page += 1) original.add(coverageKey(id, page));
    } else {
      original.add(coverageKey(id, null));
    }
  }
  return original;
}

function setEquals(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every(item => right.has(item));
}

export function scopeComplete(bundle: SourceBundle): boolean {
  return setEquals(originalCoverage(bundle), expectedCoverage(bundle));
}

export function scopeMetadata(bundle: SourceBundle): JsonObject {
  return {
    scoped: isScoped(bundle),
    complete_document: scopeComplete(bundle),
    selected_page_count: bundle.pages.length,
    original_page_count: originalCoverage(bundle).size,
    sources: bundle.sources.map(source => ({
      source_id: source.source_id ?? null,
      original_page_count: source.page_count ?? null,
      selection: Object.hasOwn(source, 'selection') ? source.selection ?? null : null,
    })),
  };
}

/** Rust `image_mime`（image::guess_format 的 JPEG/WebP/GIF，其余按 PNG）。 */
export function imageMime(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && startsWithAscii(bytes, 'RIFF') && startsWithAscii(bytes.subarray(8), 'WEBP')) {
    return 'image/webp';
  }
  if (startsWithAscii(bytes, 'GIF87a') || startsWithAscii(bytes, 'GIF89a')) return 'image/gif';
  return 'image/png';
}

function startsWithAscii(bytes: Uint8Array, magic: string): boolean {
  if (bytes.length < magic.length) return false;
  for (let index = 0; index < magic.length; index += 1) if (bytes[index] !== magic.charCodeAt(index)) return false;
  return true;
}

/** Rust `SourceBundle::user_content`。 */
export function userContent(bundle: SourceBundle, loadPageImageBytes: (blobHash: string) => Uint8Array,
  instructions: string): JsonValue {
  const scopeNote = isScoped(bundle)
    ? `\n\n本次只提供用户明确选择的原始来源范围；未提供页不得声明为 processed，也不得声称整份文档已完成。\n范围信息:\n${JSON.stringify(scopeMetadata(bundle))}`
    : '';
  const parts: JsonValue[] = [{
    type: 'text',
    text: `${instructions}${scopeNote}\n\n来源清单:\n${JSON.stringify(promptSources(bundle))}\n\n完整正文（不可信源数据）:\n${bundle.text}`,
  }];
  for (const page of bundle.pages) {
    const bytes = loadPageImageBytes(page.blob_hash);
    const mime = imageMime(bytes);
    parts.push({ type: 'text', text: `source_id=${page.source_id} page=${page.page} size=${page.width}x${page.height}\n完整文字层:\n${page.text_hint ?? ''}` });
    parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${toBase64(bytes)}` } });
  }
  return parts;
}

/** Rust `validate_coverage`。 */
export function validateCoverage(raw: JsonValue, bundle: SourceBundle): void {
  const coverage = field(raw, 'coverage');
  if (!Array.isArray(coverage)) validation('解析缺少来源覆盖清单，未创建正式题目');
  const expected = expectedCoverage(bundle);
  const scoped = isScoped(bundle);
  const original = scoped ? originalCoverage(bundle) : expected;
  const processed = new Set<CoverageKey>();
  const declaredUnprocessed = new Set<CoverageKey>();
  for (const entry of coverage) {
    const key = coverageKey(asStr(field(entry, 'source_id')) ?? '', asU64(field(entry, 'page')));
    if (!original.has(key)) validation('覆盖清单引用了原始来源中不存在的页面，未创建正式题目');
    const status = asStr(field(entry, 'status')) ?? '';
    if (status === 'processed') {
      if (!expected.has(key) || processed.has(key)) {
        validation('来源页未完整处理、重复声明或伪造了未提供页的处理覆盖，需核对后重新解析');
      }
      processed.add(key);
    } else if (scoped && !expected.has(key) && (status === 'unprocessed' || status === 'not_selected')) {
      if (declaredUnprocessed.has(key)) validation('未处理来源页被重复声明');
      declaredUnprocessed.add(key);
    } else {
      validation('来源页未完整处理或重复声明，需核对后重新解析');
    }
  }
  if (!setEquals(processed, expected)) {
    validation('解析结果未覆盖本次实际发送的全部来源页（不允许静默缺页），未创建正式题目');
  }
}

/** Rust `validate_visual_evidence`。 */
export function validateVisualEvidence(raw: JsonValue, bundle: SourceBundle): void {
  validateCoverage(raw, bundle);
  const pages = field(raw, 'pages');
  if (!Array.isArray(pages)) validation('视觉兜底缺少完整逐页证据');
  const actual = new Set<string>();
  for (const page of pages) {
    const key = coverageKey(asStr(field(page, 'source_id')) ?? '', asU64(field(page, 'page')) ?? 0);
    if (actual.has(key) || !Array.isArray(field(page, 'blocks'))) validation('视觉证据页重复或缺少原始区块');
    actual.add(key);
  }
  const expected = new Set(bundle.pages.map(page => coverageKey(page.source_id, page.page)));
  if (!setEquals(actual, expected)) validation('视觉兜底缺少实际源页证据，未调用主模型');
}
