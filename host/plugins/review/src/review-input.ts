/**
 * 命令入参规范化（拆分自 `review.ts`）。
 *
 * UUID 解析与批量 ID 去重逐条对应 Rust `Uuid::parse_str` 和
 * `normalize_card_ids` 的校验文案。
 */
import { rustTrim } from '../../../platform/util/portable.ts';
import { appError } from './errors.ts';

const SIMPLE_UUID = /^([0-9a-fA-F]{8})([0-9a-fA-F]{4})([0-9a-fA-F]{4})([0-9a-fA-F]{4})([0-9a-fA-F]{12})$/;
const HYPHENATED_UUID = /^([0-9a-fA-F]{8})-([0-9a-fA-F]{4})-([0-9a-fA-F]{4})-([0-9a-fA-F]{4})-([0-9a-fA-F]{12})$/;

/**
 * `uuid::Uuid::parse_str`（uuid 1.20 parser.rs `try_parse`）：32 位 simple，或 hyphenated
 * 本体 / `{…}` / 小写 `urn:uuid:` 前缀包裹的 hyphenated。连字符要么全有要么全无。
 */
function canonicalUuid(raw: string): string | null {
  let groups: RegExpExecArray | null = null;
  if (raw.length === 32) groups = SIMPLE_UUID.exec(raw);
  else if (raw.length === 36) groups = HYPHENATED_UUID.exec(raw);
  else if (raw.length === 38 && raw.startsWith('{') && raw.endsWith('}')) groups = HYPHENATED_UUID.exec(raw.slice(1, -1));
  else if (raw.length === 45 && raw.startsWith('urn:uuid:')) groups = HYPHENATED_UUID.exec(raw.slice(9));
  if (groups === null) return null;
  return `${groups[1]}-${groups[2]}-${groups[3]}-${groups[4]}-${groups[5]}`.toLowerCase();
}

export function parseClientOpId(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = rustTrim(raw);
  if (trimmed.length === 0) throw appError('Validation', 'clientOpId must be a valid UUID');
  const canonical = canonicalUuid(trimmed);
  if (canonical === null) throw appError('Validation', 'clientOpId must be a valid UUID');
  return canonical;
}

export function normalizeIds(
  ids: readonly string[], field: string, max = Number.POSITIVE_INFINITY,
): string[] {
  if (ids.length > max) throw appError('Validation', `${field} must contain at most ${max} entries`);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const trimmed = rustTrim(id);
    if (trimmed.length === 0) throw appError('Validation', `${field} must not contain empty IDs`);
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}
