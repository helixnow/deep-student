/**
 * APKG 导出的纯值层：文本/字段、FSRS 调度回写、遮挡卡转换、稳定 ID 与
 * Anki model/collection 构造（`apkg_exporter_service.rs:303-1453`）。
 */
import { hostPath as path } from '../../../platform/util/path.ts';
import { createHasherSync, digestSync } from '../../../platform/crypto/sync.ts';
import { toHex, utf8Encode } from '../../../platform/crypto/encoding.ts';
import { compareUtf8 } from '../../../platform/util/utf8.ts';
import type { AnkiCard } from '../../../../contracts/ipc/generated/_shared.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { insertCollectionRow } from '../repository/apkg-export.ts';
import type { AnkiLogger } from './logger.ts';
import {
  defaultOcclusionConfig,
  formatAnkiIoCloze,
  parseOcclusionField,
  validateSpec,
  type OcclusionSpec,
} from './image-occlusion.ts';
import {
  APKG_EXPORT_DECK_ID,
  APKG_MODEL_ID_BASE,
  DEEP_STUDENT_COLLAPSE_CLOZE_ORDS_KEY,
  DEEP_STUDENT_TEMPLATE_ID_KEY,
  FSRS_EXPORT_METADATA_KEY,
  RESERVED_IMPORT_METADATA_FIELDS,
  ALIAS_MAP,
  DEFAULT_DAY_ROLLOVER_HOUR,
  type TemplateConfigTuple,
} from './apkg-export-constants.ts';

export interface RevlogExport {
  idMs: number;
  ease: number;
  ivl: number;
  lastIvl: number;
  factor: number;
  timeMs: number;
  kind: number;
}

export interface FsrsSchedExport {
  cardType: number;
  queue: number;
  left: number;
  data: string;
  revlog: RevlogExport[];
}

export interface CardSchedRestore {
  due: number;
  ivl: number;
  factor: number;
  reps: number;
  lapses: number;
  fsrs: FsrsSchedExport | null;
}

// ============================== 纯文本 / 字段 ==============================

const CITATION_ANY_RE = /\[(?:PDF@|思维导图:|导图:|脑图:|mindmap:|题目集:|题库:|练习册:|questionbank:|question[_ ]?bank:|qbank:|知识库-|knowledge|记忆-|memory-|搜索-|search-|web-|图片-|image-|灵感-|insight-)/i;
const CITATION_PDF_RE = /\[PDF@[A-Za-z0-9_-]+:\s*(\d+(?:[-,]\d+)*)\]/gi;
const CITATION_PDF_BARE_RE = /\[PDF@[A-Za-z0-9_-]+\]/gi;
const CITATION_TITLED_RE = /\[(?:(?:思维导图|导图|脑图|mindmap):(?:mm_|mv_)[A-Za-z0-9_-]+(?:#[^:\]\n]+)?|(?:题目集|题库|练习册|questionbank|question[_ ]?bank|qbank):[\p{L}\p{N}_-]+)(?::([^\]]+))?\]/giu;
const CITATION_RETRIEVAL_RE = /\[(?:知识库|knowledge base|knowledge|记忆|memory|搜索|search|web|图片|image|灵感|insight)-\d+\]/gi;
const CITATION_GAP_RE = /[ \t]{2,}/g;
const CITATION_SPACE_BEFORE_PUNCT_RE = /\s+([，。；、,.;)）])/g;
const CITATION_TRAILING_SEP_RE = /[ \t]*[；;，,、][ \t]*$/gm;

/** 聊天引用标记 → 可读文字（`apkg_exporter_service.rs:303-322`）。 */
export function humanizeCitationMarkers(text: string): string {
  if (!CITATION_ANY_RE.test(text)) return text;
  let out = text.replace(CITATION_PDF_RE, (_match, group: string) => `第 ${group.replace(/,/g, '、')} 页`);
  out = out.replace(CITATION_PDF_BARE_RE, '');
  out = out.replace(CITATION_TITLED_RE, (_match, title: string | undefined) => title?.trim() ?? '');
  out = out.replace(CITATION_RETRIEVAL_RE, '');
  out = out.replace(CITATION_GAP_RE, ' ');
  out = out.replace(CITATION_SPACE_BEFORE_PUNCT_RE, '$1');
  out = out.replace(CITATION_TRAILING_SEP_RE, '');
  return out.trimEnd();
}

/** 导出写入 notes.flds 前清洗字段值（U+001F + 引用标记）。 */
export function sanitizeApkgFieldValue(value: string): string {
  const humanized = humanizeCitationMarkers(value);
  return humanized.includes('\u001f') ? humanized.replace(/\u001f/g, ' ') : humanized;
}

/** `Path::file_name()` 的文件名部分。 */
export function fileNameOf(imagePath: string): string | null {
  const name = path.basename(imagePath);
  return name === '' || name === '.' || name === '..' ? null : name;
}

export function isReservedImportMetadataField(name: string): boolean {
  const lowered = name.toLowerCase();
  return RESERVED_IMPORT_METADATA_FIELDS.some((field) => field.toLowerCase() === lowered);
}

export function isInternalProtocolField(name: string): boolean {
  return name.startsWith('_') || isReservedImportMetadataField(name);
}

/** `clean_template_placeholders`：仅去首尾空白。 */
export function cleanTemplatePlaceholders(content: string): string {
  return content.trim();
}

/** `contains_cloze_marker`（`apkg_exporter_service.rs:324-345`）。 */
export function containsClozeMarker(text: string): boolean {
  let searchFrom = 0;
  while (true) {
    const relativeStart = text.indexOf('{{c', searchFrom);
    if (relativeStart < 0) return false;
    const numberStart = relativeStart + 3;
    let digitCount = 0;
    while (numberStart + digitCount < text.length && text.charCodeAt(numberStart + digitCount) >= 48
      && text.charCodeAt(numberStart + digitCount) <= 57) {
      digitCount += 1;
    }
    if (digitCount > 0 && text.startsWith('::', numberStart + digitCount)) return true;
    searchFrom = numberStart;
  }
}

/** `cloze_card_ords`（`apkg_exporter_service.rs:454-511`）。 */
export function clozeCardOrds(text: string): number[] {
  const ords = new Set<number>();
  let searchFrom = 0;

  while (true) {
    const relativeStart = text.indexOf('{{c', searchFrom);
    if (relativeStart < 0) break;
    const markerStart = relativeStart;
    const numberStart = markerStart + 3;
    let digitCount = 0;
    while (numberStart + digitCount < text.length && text.charCodeAt(numberStart + digitCount) >= 48
      && text.charCodeAt(numberStart + digitCount) <= 57) {
      digitCount += 1;
    }
    if (digitCount === 0) {
      searchFrom = numberStart;
      continue;
    }

    const numberEnd = numberStart + digitCount;
    if (!text.startsWith('::', numberEnd)) {
      searchFrom = numberEnd;
      continue;
    }

    const answerStart = numberEnd + 2;
    const remainder = text.slice(answerStart);
    const relativeClose = remainder.indexOf('}}');
    if (relativeClose < 0) break;
    const relativeNested = remainder.indexOf('{{c');
    if (relativeNested >= 0 && relativeNested < relativeClose) {
      searchFrom = answerStart + relativeNested;
      continue;
    }

    const markerEnd = answerStart + relativeClose;
    const body = text.slice(answerStart, markerEnd);
    const separator = body.indexOf('::');
    const answer = separator < 0 ? body : body.slice(0, separator);
    if (answer.trim() !== '') {
      const number = Number(text.slice(numberStart, numberEnd));
      if (Number.isSafeInteger(number) && number >= 1) {
        ords.add(number - 1);
      }
    }
    searchFrom = markerEnd + 2;
  }

  return ords.size === 0 ? [0] : [...ords].sort((a, b) => a - b);
}

/** `strip_html_for_checksum`（`apkg_exporter_service.rs:847-865`）。 */
export function stripHtmlForChecksum(text: string): string {
  let out = '';
  let inTag = false;
  for (const ch of text) {
    if (ch === '<') {
      inTag = true;
    } else if (ch === '>') {
      inTag = false;
    } else if (!inTag) {
      out += ch;
    }
  }
  return out;
}

/** `field_checksum`：strip HTML 后 SHA1 前 4 字节大端。 */
export function fieldChecksum(text: string): number {
  const stripped = stripHtmlForChecksum(text);
  if (stripped === '') return 0;
  const digest = digestSync('SHA-1', stripped);
  return new DataView(digest.buffer, digest.byteOffset, digest.byteLength).getUint32(0);
}

/** `fsrs_difficulty_to_factor`（`apkg_exporter_service.rs:547-554`）。 */
export function fsrsDifficultyToFactor(difficulty: number): number {
  const d = Math.min(10, Math.max(1, difficulty));
  return Math.round((1.3 + ((10 - d) / 9) * 1.7) * 1000);
}

/** 本地逻辑日（`dstu-learning/src/fsrs_scheduler.rs:429-478` 的本地时区等价实现）。 */
function localDateParts(ms: number, rolloverHour: number): [number, number, number] {
  const date = new Date(ms - rolloverHour * 3_600_000);
  return [date.getFullYear(), date.getMonth(), date.getDate()];
}

function logicalDaysBetween(fromMs: number, toMs: number, rolloverHour: number): number {
  const hour = Math.min(23, rolloverHour);
  const from = localDateParts(fromMs, hour);
  const to = localDateParts(toMs, hour);
  const days = Math.round((Date.UTC(...to) - Date.UTC(...from)) / 86_400_000);
  return Math.max(0, Math.min(4_294_967_295, days));
}

function logicalDayBoundsMs(nowMs: number, rolloverHour: number): [number, number] {
  const hour = Math.min(23, rolloverHour);
  const [year, month, day] = localDateParts(nowMs, hour);
  const start = new Date(year, month, day, hour, 0, 0, 0).getTime();
  const next = new Date(year, month, day + 1, hour, 0, 0, 0).getTime();
  return [start, Math.max(start + 1, next)];
}

function asI64(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function asU64(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function asF64(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** `fsrs_sched_restore`（`apkg_exporter_service.rs:556-711`）。 */
export function fsrsSchedRestore(raw: string, nowMs: number): CardSchedRestore | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;

  const state = asI64(value.state);
  if (state === null || state < 1 || state > 3) return null;
  const stability = asF64(value.s);
  if (stability === null || stability <= 0) return null;
  const difficulty = asF64(value.d);
  if (difficulty === null) return null;
  const dueMs = asI64(value.due);
  if (dueMs === null) return null;
  const rolloverRaw = asU64(value.rollover);
  const rollover = rolloverRaw === null ? DEFAULT_DAY_ROLLOVER_HOUR : Math.min(23, rolloverRaw);
  const reps = Math.max(0, asI64(value.reps) ?? 0);
  const lapses = Math.max(0, asI64(value.lapses) ?? 0);
  const suspended = asBool(value.susp) ?? false;
  const factor = fsrsDifficultyToFactor(difficulty);

  const daysUntilDue = dueMs > nowMs ? logicalDaysBetween(nowMs, dueMs, rollover) : 0;

  let cardType: number;
  let queue: number;
  let due: number;
  let ivl: number;
  let left: number;
  if (state === 2) {
    const rawIvl = asF64(value.ivl) ?? stability;
    ivl = Math.min(36_500, Math.max(1, Math.round(rawIvl)));
    cardType = 2;
    queue = 2;
    due = daysUntilDue;
    left = 0;
  } else {
    const [, nextDayStart] = logicalDayBoundsMs(nowMs, rollover);
    ivl = state === 3 ? Math.min(36_500, Math.max(1, Math.round(stability))) : 0;
    cardType = state;
    if (dueMs < nextDayStart) {
      queue = 1;
      due = Math.trunc(Math.max(0, dueMs) / 1000);
      left = 1001;
    } else {
      queue = 3;
      due = daysUntilDue;
      left = 1001;
    }
  }
  if (suspended) queue = -1;

  const data: Record<string, number> = {};
  data.d = round4(Math.min(10, Math.max(1, difficulty)));
  const decay = asF64(value.decay);
  if (decay !== null && decay > 0) data.decay = round4(decay);
  const desiredRetention = asF64(value.dr);
  if (desiredRetention !== null && desiredRetention > 0 && desiredRetention < 1) {
    data.dr = round4(desiredRetention);
  }
  const lastReviewMs = asI64(value.lrt);
  if (lastReviewMs !== null) data.lrt = Math.trunc(lastReviewMs / 1000);
  data.s = round4(stability);
  const revlog: RevlogExport[] = [];
  let lastIvl = 0;
  const reviews = Array.isArray(value.rev) ? value.rev : [];
  for (const entry of reviews) {
    if (!Array.isArray(entry)) continue;
    const reviewMs = asI64(entry[0]);
    const rating = asI64(entry[1]);
    const stateBefore = asI64(entry[2]);
    const stateAfter = asI64(entry[3]);
    if (reviewMs === null || rating === null || stateBefore === null || stateAfter === null) continue;
    if (rating < 1 || rating > 4) continue;
    const scheduledDays = asF64(entry[4]) ?? 0;
    let entryIvl: number;
    if (stateAfter === 2) {
      entryIvl = Math.max(1, Math.round(scheduledDays));
    } else {
      const dueAfter = asI64(entry[5]);
      const seconds = dueAfter === null ? 60 : Math.trunc((dueAfter - reviewMs) / 1000);
      entryIvl = -Math.max(60, seconds);
    }
    const kind = stateBefore === 2 ? 1 : stateBefore === 3 ? 2 : 0;
    const duration = asI64(entry[6]) ?? 0;
    revlog.push({
      idMs: reviewMs,
      ease: rating,
      ivl: entryIvl,
      lastIvl,
      factor: kind === 0 ? 0 : factor,
      timeMs: Math.min(600_000, Math.max(0, duration)),
      kind,
    });
    lastIvl = entryIvl;
  }

  return {
    due,
    ivl,
    factor,
    reps,
    lapses,
    fsrs: { cardType, queue, left, data: JSON.stringify(data), revlog },
  };
}

function parseI64Text(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** `card_sched_restore`（`apkg_exporter_service.rs:713-745`）。 */
export function cardSchedRestore(card: AnkiCard, nowMs = Date.now()): CardSchedRestore | null {
  const raw = card.extra_fields[FSRS_EXPORT_METADATA_KEY];
  if (raw !== undefined) return fsrsSchedRestore(raw, nowMs);

  const get = (key: string): number | null => parseI64Text(card.extra_fields[key]);
  let ivl = get('AnkiIvl') ?? 0;
  const reps = get('AnkiReps') ?? 0;
  if (ivl <= 0 || reps <= 0) return null;
  ivl = Math.min(ivl, 36_500);
  const rawFactor = get('AnkiFactor');
  const factor = rawFactor !== null && rawFactor >= 1000 && rawFactor <= 9999 ? rawFactor : 2500;
  const lapses = Math.min(9_999, Math.max(0, get('AnkiLapses') ?? 0));
  const rawDue = get('AnkiDue');
  const due = rawDue !== null && rawDue >= 1 && rawDue <= ivl ? rawDue : ivl;
  return { due, ivl, factor, reps: Math.min(reps, 1_000_000), lapses, fsrs: null };
}

// ============================== 遮挡卡转换 ==============================

export function occlusionMediaFileName(imageRef: string): string | null {
  const trimmed = imageRef.trim();
  if (trimmed === '' || trimmed.startsWith('vlm://')) return null;
  const name = fileNameOf(trimmed);
  return name === null || name.trim() === '' ? null : name;
}

function escapeOcclusionClozeLabel(label: string): string {
  return label.replace(/\}\}/g, '} }').replace(/::/g, '：：');
}

function escapeOcclusionHtmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

export function buildOcclusionClozeText(spec: OcclusionSpec): string {
  return spec.boxes.map((box, index) => {
    const ord = box.clozeIndex != null && box.clozeIndex > 0 ? box.clozeIndex : index + 1;
    const trimmed = box.label.trim();
    const label = trimmed === '' ? `区域 ${ord}` : trimmed;
    return `{{c${ord}::${escapeOcclusionClozeLabel(label)}}}`;
  }).join(' ');
}

/** 官方 IO 矩形 cloze 语法；spec 非法时返回空串（保留给 IO notetype 导出路径）。 */
export function formatIoRects(spec: OcclusionSpec): string {
  const validated = validateSpec(spec, defaultOcclusionConfig());
  return validated.ok ? formatAnkiIoCloze(validated.value) : '';
}

export function convertOcclusionCardForExport(card: AnkiCard): void {
  const spec = parseOcclusionField(card.extra_fields);
  if (spec === null) return;

  const imageFileName = occlusionMediaFileName(spec.imageRef);
  if (card.images.length === 0 && imageFileName !== null) {
    card.images.push(spec.imageRef.trim());
  }

  const existingText = card.text?.trim();
  const clozeBody = existingText !== undefined && existingText !== ''
    ? existingText
    : buildOcclusionClozeText(spec);
  if (clozeBody !== '') {
    card.text = imageFileName !== null && !clozeBody.includes('<img')
      ? `<img src="${escapeOcclusionHtmlAttr(imageFileName)}"><br>${clozeBody}`
      : clozeBody;
  }
}

/** 导出入口规范化：遮挡转换 + 删除 `_` 前缀机器字段。 */
export function normalizeCardsForExport(cards: AnkiCard[]): void {
  for (const card of cards) {
    convertOcclusionCardForExport(card);
    for (const key of Object.keys(card.extra_fields)) {
      if (key.startsWith('_')) delete card.extra_fields[key];
    }
  }
}

// ============================== 字段解析 ==============================

/** `resolve_card_field_value`（`apkg_exporter_service.rs:867-960`）。 */
export function resolveCardFieldValue(card: AnkiCard, fieldName: string, logger?: Pick<AnkiLogger, 'warn'>): string {
  const lowered = fieldName.toLowerCase();
  switch (lowered) {
    case 'front': {
      if (card.template_id === 'choice-card') {
        const value = card.extra_fields[lowered] ?? card.extra_fields[fieldName];
        return value ?? cleanTemplatePlaceholders(card.front);
      }
      return cleanTemplatePlaceholders(card.front);
    }
    case 'back':
      return cleanTemplatePlaceholders(card.back);
    case 'text': {
      const textValue = card.text?.trim();
      const fallback = card.extra_fields[lowered] ?? card.extra_fields[fieldName];
      const value = textValue !== undefined && textValue !== '' ? textValue : fallback ?? '';
      if (value.trim() === '' && containsClozeMarker(card.front)) {
        return cleanTemplatePlaceholders(card.front);
      }
      return cleanTemplatePlaceholders(value);
    }
    case 'extra': {
      const value = card.extra_fields[lowered] ?? card.extra_fields[fieldName];
      return value ?? cleanTemplatePlaceholders(card.back);
    }
    case 'tags':
      return card.tags.length === 0 ? '' : cleanTemplatePlaceholders(card.tags.join(', '));
    default: {
      if (isInternalProtocolField(fieldName)) return '';
      let rawValue = card.extra_fields[lowered] ?? card.extra_fields[fieldName];
      if (rawValue === undefined) {
        const aliases = ALIAS_MAP[lowered];
        if (aliases !== undefined) {
          for (const alias of aliases) {
            if (card.extra_fields[alias] !== undefined) {
              rawValue = card.extra_fields[alias];
              break;
            }
          }
        }
      }
      if (rawValue === undefined) logger?.warn(`字段 '${fieldName}' 未找到，使用空值`);
      const value = rawValue ?? '';
      const trimmedStart = value.trimStart();
      return trimmedStart.startsWith('{') || trimmedStart.startsWith('[')
        ? value
        : cleanTemplatePlaceholders(value);
    }
  }
}

// ============================== 稳定 ID / GUID ==============================

/** FNV-1a 64 位 → 稳定 model id（`apkg_exporter_service.rs:46-55`）。 */
export function stableModelIdForTemplate(templateId: string): number {
  let hash = 0xcbf2_9ce4_8422_2325n;
  for (const byte of utf8Encode(templateId)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x0000_0100_0000_01b3n) & 0xffff_ffff_ffff_ffffn;
  }
  return APKG_MODEL_ID_BASE + 1 + Number(hash % (1n << 52n));
}

/** 稳定 note guid（`apkg_exporter_service.rs:347-397`）。 */
export function stableNoteGuid(card: AnkiCard): string {
  const hasher = createHasherSync('SHA-1');
  hasher.update('deep-student-apkg-guid-v1');
  hasher.update(new Uint8Array([0x1f]));
  const cardId = card.id.trim();
  if (cardId !== '') {
    hasher.update('id');
    hasher.update(new Uint8Array([0x1f]));
    hasher.update(cardId);
  } else {
    hasher.update('content');
    hasher.update(new Uint8Array([0x1f]));
    hasher.update(card.front);
    hasher.update(new Uint8Array([0x1f]));
    hasher.update(card.back);
    hasher.update(new Uint8Array([0x1f]));
    if (card.text !== null) hasher.update(card.text);
    hasher.update(new Uint8Array([0x1f]));
    const keys = Object.keys(card.extra_fields).sort(compareUtf8);
    for (const key of keys) {
      hasher.update(key);
      hasher.update(new Uint8Array([0x1e]));
      hasher.update(card.extra_fields[key]!);
      hasher.update(new Uint8Array([0x1e]));
    }
    hasher.update(new Uint8Array([0x1f]));
    for (const tag of card.tags) {
      hasher.update(tag);
      hasher.update(new Uint8Array([0x1e]));
    }
    hasher.update(new Uint8Array([0x1f]));
    if (card.template_id !== null) hasher.update(card.template_id);
  }
  return toHex(hasher.digest().subarray(0, 10));
}

export function uniqueNoteGuid(card: AnkiCard, used: Set<string>): string {
  const base = stableNoteGuid(card);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let suffix = 2;
  while (true) {
    const candidate = `${base}-${suffix}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    suffix += 1;
  }
}

let lastNoteId = 0;
let lastCardId = 0;

export function nextApkgNoteId(nowMs = Date.now()): number {
  lastNoteId = Math.max(lastNoteId + 1, nowMs);
  return lastNoteId;
}

export function nextApkgCardId(nowMs = Date.now()): number {
  lastCardId = Math.max(lastCardId + 1, nowMs);
  return lastCardId;
}

/** 测试重置全局 ID 生成器（Rust 每个进程一次，测试之间不重置）。 */
export function resetApkgIdGenerators(): void {
  lastNoteId = 0;
  lastCardId = 0;
}

// ============================== Anki model / collection ==============================

interface AnkiTemplateModel {
  name: string;
  ord: number;
  qfmt: string;
  afmt: string;
  bqfmt: string;
  bafmt: string;
  did: number | null;
  bfont: string;
  bsize: number;
}

interface AnkiFieldModel {
  name: string;
  ord: number;
  sticky: boolean;
  rtl: boolean;
  font: string;
  size: number;
  media: string[];
  description: string;
}

export interface AnkiModel {
  vers: number[];
  name: string;
  type: number;
  mod: number;
  usn: number;
  sortf: number;
  did: number;
  tmpls: AnkiTemplateModel[];
  flds: AnkiFieldModel[];
  css: string;
  latexPre: string;
  latexPost: string;
  tags: string[];
  id: number;
  req: unknown[][];
}

const LATEX_PRE = '\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n';
const LATEX_POST = '\\end{document}';

export const ANKI_COLLECTION_CONFIG = `{
    "nextPos": 1,
    "estTimes": true,
    "activeDecks": [1],
    "sortType": "noteFld",
    "timeLim": 0,
    "sortBackwards": false,
    "addToCur": true,
    "curDeck": 1,
    "newBury": 0,
    "newSpread": 0,
    "dueCounts": true,
    "curModel": "1425279151691",
    "collapseTime": 1200
}`;

function templateModel(name: string, qfmt: string, afmt: string): AnkiTemplateModel {
  return {
    name,
    ord: 0,
    qfmt,
    afmt,
    bqfmt: '',
    bafmt: '',
    did: null,
    bfont: 'Arial',
    bsize: 12,
  };
}

function fieldModels(fields: readonly string[]): AnkiFieldModel[] {
  return fields.map((name, ord) => ({
    name,
    ord,
    sticky: false,
    rtl: false,
    font: 'Arial',
    size: 20,
    media: [],
    description: '',
  }));
}

export function createBasicModel(nowSeconds = Math.floor(Date.now() / 1000)): AnkiModel {
  return {
    vers: [],
    name: 'Basic',
    type: 0,
    mod: nowSeconds,
    usn: -1,
    sortf: 0,
    did: APKG_EXPORT_DECK_ID,
    tmpls: [templateModel('Card 1', '{{Front}}', '{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}')],
    flds: fieldModels(['Front', 'Back']),
    css: '.card {\n font-family: arial;\n font-size: 20px;\n text-align: center;\n color: black;\n background-color: white;\n}',
    latexPre: LATEX_PRE,
    latexPost: LATEX_POST,
    tags: [],
    id: 1425279151691,
    req: [[0, 'any', [0]]],
  };
}

export function createClozeModel(nowSeconds = Math.floor(Date.now() / 1000)): AnkiModel {
  return {
    vers: [],
    name: 'Cloze',
    type: 1,
    mod: nowSeconds,
    usn: -1,
    sortf: 0,
    did: APKG_EXPORT_DECK_ID,
    tmpls: [templateModel('Cloze', '{{cloze:Text}}', '{{cloze:Text}}<br>{{Extra}}')],
    flds: fieldModels(['Text', 'Extra']),
    css: '.card {\n font-family: arial;\n font-size: 20px;\n text-align: center;\n color: black;\n background-color: white;\n}\n.cloze {\n font-weight: bold;\n color: blue;\n}',
    latexPre: LATEX_PRE,
    latexPost: LATEX_POST,
    tags: [],
    id: 1425279151692,
    req: [[0, 'all', [0]]],
  };
}

export function createTemplateModel(
  templateId: string | null,
  templateName: string,
  fields: readonly string[],
  frontTemplate: string,
  backTemplate: string,
  cssStyle: string,
  modelType: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): AnkiModel {
  return {
    vers: [],
    name: templateName,
    type: modelType,
    mod: nowSeconds,
    usn: -1,
    sortf: 0,
    did: APKG_EXPORT_DECK_ID,
    tmpls: [templateModel('Card 1', frontTemplate, backTemplate)],
    flds: fieldModels(fields),
    css: cssStyle,
    latexPre: LATEX_PRE,
    latexPost: LATEX_POST,
    tags: [],
    id: templateId === null ? 1425279151691 : Number(templateId),
    req: [[0, modelType === 1 ? 'all' : 'any', [0]]],
  };
}


function deckRecords(deckName: string, nowSeconds: number): Record<string, unknown> {
  const deckId = APKG_EXPORT_DECK_ID;
  return {
    [deckId]: {
      id: deckId,
      name: deckName,
      extendRev: 50,
      usn: 0,
      collapsed: false,
      newToday: [0, 0],
      revToday: [0, 0],
      lrnToday: [0, 0],
      timeToday: [0, 0],
      dyn: 0,
      extendNew: 10,
      conf: 1,
      desc: '',
      browserCollapsed: true,
      mod: nowSeconds,
    },
  };
}

const DCONF_RECORD = {
  1: {
    id: 1,
    name: 'Default',
    replayq: true,
    lapse: { leechFails: 8, minInt: 1, leechAction: 0, delays: [10], mult: 0 },
    rev: { perDay: 200, ivlFct: 1, maxIvl: 36500, ease4: 1.3, bury: true, minSpace: 1 },
    timer: 0,
    maxTaken: 60,
    usn: 0,
    new: {
      perDay: 20,
      delays: [1, 10],
      separate: true,
      ints: [1, 4, 7],
      initialFactor: 2500,
      bury: true,
      order: 1,
    },
    mod: 0,
    autoplay: true,
  },
} as const;

export function insertCollection(
  db: DatabaseHandle,
  models: Record<string, unknown>,
  deckName: string,
  nowSeconds: number,
): void {
  const dconf = structuredClone(DCONF_RECORD) as { 1: { mod: number } };
  dconf[1].mod = nowSeconds;
  insertCollectionRow(db, {
    nowSeconds,
    configJson: ANKI_COLLECTION_CONFIG,
    modelsJson: JSON.stringify(models),
    decksJson: JSON.stringify(deckRecords(deckName, nowSeconds)),
    dconfJson: JSON.stringify(dconf),
  });
}

/** `initialize_anki_database_with_template`（`apkg_exporter_service.rs:1235-1453`）。 */
export function initializeAnkiDatabaseWithTemplate(
  db: DatabaseHandle,
  deckName: string,
  modelName: string,
  templateConfig: TemplateConfigTuple | null,
  templateId: string | null,
  nowSeconds = Math.floor(Date.now() / 1000),
): [deckId: number, modelId: number] {
  const deckId = APKG_EXPORT_DECK_ID;
  const modelId = modelName === 'Cloze' ? 1425279151692 : 1425279151691;

  const model = templateConfig !== null
    ? createTemplateModel(
      String(modelId),
      templateConfig[0],
      templateConfig[1],
      templateConfig[2],
      templateConfig[3],
      templateConfig[4],
      modelName.toLowerCase() === 'cloze' ? 1 : 0,
      nowSeconds,
    )
    : modelName === 'Cloze'
      ? createClozeModel(nowSeconds)
      : createBasicModel(nowSeconds);

  const modelValue = model as unknown as Record<string, unknown>;
  modelValue[DEEP_STUDENT_COLLAPSE_CLOZE_ORDS_KEY] = true;
  const trimmedTemplateId = templateId?.trim() ?? '';
  if (trimmedTemplateId !== '') {
    modelValue[DEEP_STUDENT_TEMPLATE_ID_KEY] = trimmedTemplateId;
  }

  insertCollection(db, { [String(model.id)]: modelValue }, deckName, nowSeconds);
  return [deckId, modelId];
}
