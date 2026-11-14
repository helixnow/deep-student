/**
 * `question_authoring_runner.rs` 中导入路径独用的 SourceBundle 方法
 * （H2 的 `source-bundle.ts` 提供覆盖/提示词部分，这里只补导入用到的其余方法）：
 * - `legacy_pages`（137-148）
 * - `expected_coverage_metadata` / `original_coverage_metadata` + `coverage_metadata`（218-228、449-456）
 * - `validate_source_identity`（233-283）
 */
import { AppError } from '../../../platform/errors/api.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';
import { compareUtf8, utf8ByteLength } from '../../../platform/util/portable.ts';
import type { PageSlice } from '../../media/api.ts';
import { QbankServiceError } from './question-service.ts';
import { expectedCoverage, originalCoverage, type CoverageKey, type SourceBundle } from './source-bundle.ts';

function validation(message: string): never {
  throw new QbankServiceError(AppError.validation(message));
}

/** Rust `SourceBundle::legacy_pages`：页序号即 bundle 内的顺序（0 起）。 */
export function legacyPages(bundle: SourceBundle): PageSlice[] {
  return bundle.pages.map((page, index) => ({
    page_index: index,
    blob_hash: page.blob_hash,
    text_hint: page.text_hint,
    width: page.width,
    height: page.height,
  }));
}

function decodeKey(key: CoverageKey): [string, number | null] {
  const split = key.lastIndexOf('\u0000');
  const page = key.slice(split + 1);
  return [key.slice(0, split), page === '' ? null : Number(page)];
}

/**
 * Rust `coverage_metadata`：按 (source_id, page) 排序；`Option<u64>` 的序为 None < Some，
 * 字符串按字节序比较（`String::cmp`），这里按 UTF-16 码元序比较会在代理对上不同，
 * 因此按 UTF-8 字节序比较。
 */
function coverageMetadata(coverage: Set<CoverageKey>): JsonValue[] {
  const entries = [...coverage].map(decodeKey);
  entries.sort((left, right) => {
    const bySource = compareUtf8(left[0], right[0]);
    if (bySource !== 0) return bySource;
    if (left[1] === right[1]) return 0;
    if (left[1] === null) return -1;
    if (right[1] === null) return 1;
    return left[1] - right[1];
  });
  return entries.map(([sourceId, page]) => ({ source_id: sourceId, page }));
}

/** Draft-review guard data：本次必须覆盖的页。 */
export function expectedCoverageMetadata(bundle: SourceBundle): JsonValue[] {
  return coverageMetadata(expectedCoverage(bundle));
}

/** 完整原始文档的来源记录（含范围外页），不得当作已处理覆盖。 */
export function originalCoverageMetadata(bundle: SourceBundle): JsonValue[] {
  return coverageMetadata(originalCoverage(bundle));
}

/** Rust `str::trim().is_empty()`：White_Space 属性（JS `trim` 额外去掉 U+FEFF，不能直接用）。 */
export function isRustBlank(value: string): boolean {
  return /^\p{White_Space}*$/u.test(value);
}

function nonBlankString(value: JsonValue | undefined): string | null {
  return typeof value === 'string' && !isRustBlank(value) ? value : null;
}

/** Rust `SourceBundle::validate_source_identity`：草稿可提交前所有来源须有稳定身份。 */
export function validateSourceIdentity(bundle: SourceBundle): void {
  const ids = new Set<string>();
  for (const source of bundle.sources) {
    const id = nonBlankString(source.source_id);
    if (id === null) validation('来源缺少source_id');
    if (ids.has(id)) validation(`来源标识重复: ${id}`);
    ids.add(id);
    if (nonBlankString(source.blob_hash) === null) validation(`来源 ${id} 缺少稳定blob哈希`);
    const contentHash = nonBlankString(source.content_hash);
    if (contentHash === null) validation(`来源 ${id} 缺少稳定内容哈希`);
    // Rust `len() != 64`：字节长度；非 ASCII 字符必然不是十六进制，两种判断合起来等价。
    if (utf8ByteLength(contentHash) !== 64 || !/^[0-9a-fA-F]+$/.test(contentHash)) {
      validation(`来源 ${id} 的稳定内容哈希格式无效`);
    }
  }
  for (const page of bundle.pages) {
    if (isRustBlank(page.blob_hash)) validation(`来源 ${page.source_id} 第 ${page.page} 页缺少页图哈希`);
    if (!ids.has(page.source_id)) validation(`页 ${page.page} 引用了不存在的来源 ${page.source_id}`);
  }
}
