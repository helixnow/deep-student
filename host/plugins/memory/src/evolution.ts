/**
 * Memory evolution pure layer — TS mirror of `dstu-memory/src/memory/evolution.rs`
 * (tag counters, dual-threshold staleness, promotion prompt/parse/fingerprint).
 */
import { encodeUtf8 } from '../../../platform/util/portable.ts';
import { enhancedCleanJsonResponse, extractJsonObject } from './json.ts';
import {
  emptyProfileUpdate, isProfileContentEmpty, renderLearnerProfile,
  type LearnerProfile, type LearnerProfileUpdate, type LearningGoal, type WeakPoint,
} from './learner-profile.ts';

export const HIGH_FREQ_HITS_THRESHOLD = 5;
export const HIGH_FREQ_USED_THRESHOLD = 3;
export const PROMOTION_SCAN_DAYS = 7;
export const PROMOTION_LAST_FINGERPRINT_KEY = 'learner_promotion_last_fingerprint';
export const TAG_STALE = '_stale';
export const TAG_IMPORTANT = '_important';

export interface DailyLogRecord {
  date: string;
  noteId: string;
  content: string;
}

function parseTagNumber(tags: readonly string[], prefix: string): number | null {
  for (const tag of tags) {
    if (!tag.startsWith(prefix)) continue;
    const raw = tag.slice(prefix.length);
    if (!/^[0-9]+$/.test(raw)) continue;
    const value = Number(raw);
    if (value <= 0xffffffff) return value;
  }
  return null;
}

/** Rust `MemoryEvolution::extract_hits`. */
export function extractHits(tags: readonly string[]): number {
  return parseTagNumber(tags, '_hits:') ?? 0;
}

/** Rust `MemoryEvolution::extract_used`. */
export function extractUsed(tags: readonly string[]): number {
  return parseTagNumber(tags, '_used:') ?? 0;
}

function parseTagI64(tags: readonly string[], prefix: string): number | null {
  for (const tag of tags) {
    if (!tag.startsWith(prefix)) continue;
    const raw = tag.slice(prefix.length);
    if (!/^-?[0-9]+$/.test(raw)) continue;
    const value = Number(raw);
    if (Number.isInteger(value) && value >= -(2 ** 63) && value <= 2 ** 63 - 1) return value;
  }
  return null;
}

/** Rust `MemoryEvolution::extract_last_hit_ms`. */
export function extractLastHitMs(tags: readonly string[]): number | null {
  return parseTagI64(tags, '_last_hit:');
}

/** Rust `MemoryEvolution::extract_last_injected_ms`. */
export function extractLastInjectedMs(tags: readonly string[]): number | null {
  return parseTagI64(tags, '_last_injected:');
}

function validTimestampMs(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  // chrono `DateTime::from_timestamp_millis` rejects values outside its range.
  if (value < -8.64e15 || value > 8.64e15) return null;
  return value;
}

/** Rust `signal_within_days` (invalid/missing signals are always outside the window). */
export function signalWithinDays(nowMs: number, signalMs: number | null, windowDays: number): boolean {
  const ts = validTimestampMs(signalMs);
  if (ts === null) return false;
  return Math.trunc((nowMs - ts) / 86_400_000) <= windowDays;
}

/** Rust `updated_at_age_days` (invalid timestamps are treated as maximally old). */
export function updatedAtAgeDays(nowMs: number, updatedAt: string): number {
  const parsed = Date.parse(updatedAt);
  if (!Number.isFinite(parsed)) return Number.POSITIVE_INFINITY;
  return Math.trunc((nowMs - parsed) / 86_400_000);
}

/** Rust `days_since_best_signal` (latest of hit/injected, fallback updated_at). */
export function daysSinceBestSignal(nowMs: number, lastHitMs: number | null,
  lastInjectedMs: number | null, updatedAt: string): number {
  const hit = validTimestampMs(lastHitMs);
  const injected = validTimestampMs(lastInjectedMs);
  const best = hit !== null && injected !== null
    ? Math.max(hit, injected)
    : (hit ?? injected);
  if (best === null) return updatedAtAgeDays(nowMs, updatedAt);
  return Math.trunc((nowMs - best) / 86_400_000);
}

/** Rust `build_promotion_prompt` (exact prompt text; empty profile placeholder). */
export function buildPromotionPrompt(logs: readonly DailyLogRecord[],
  profile: LearnerProfile): string {
  let logsSection = '';
  for (const log of logs) logsSection += `### ${log.date}\n${log.content}\n\n`;
  const profileSection = isProfileContentEmpty(profile)
    ? '（当前画像为空）' : renderLearnerProfile(profile);

  return `你是学习者画像的策展人。请对比"近期学习日志"与"当前画像"，识别**反复出现**的错误模式和偏好/状态变化，输出画像的增量更新提案。

## 当前学习者画像
${profileSection}

## 近 7 天学习日志
${logsSection}
## 提案规则
1. 只提炼**跨多天反复出现**或**证据充分**的模式，单次偶发错误不要写入画像
2. weak_points_add：科目 + 知识点 + 错误模式一句话概括，evidence_count 填日志中观察到的次数
3. 日志显示某薄弱点已连续多天正确、明显克服时，放入 weak_points_remove
4. 偏好只在日志中有明确信号时更新（如反复要求某种讲解方式）
5. recent_status：用 1-2 句话概括近期学习状态（可选）
6. 没有值得更新的内容时，所有字段返回空

## 输出格式（严格 JSON，不要其他内容）
{
  "weak_points_add": [
    {"subject": "数学", "knowledge_point": "二次函数", "error_pattern": "配方时符号处理错误", "evidence_count": 3, "last_seen": "2026-07-08"}
  ],
  "weak_points_remove": [
    {"subject": "科目", "knowledge_point": "已克服的知识点"}
  ],
  "preferences": {"explanation_style": null, "language": null, "pace": null, "others_add": [], "others_remove": []},
  "goals_add": [],
  "goals_remove": [],
  "recent_status": null
}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function optionalString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  return typeof value === 'string' ? value : undefined;
}
function parseWeakPoint(value: unknown): WeakPoint | null {
  if (!isRecord(value)) return null;
  const subject = value['subject'];
  const point = value['knowledge_point'];
  const pattern = value['error_pattern'];
  const evidence = value['evidence_count'];
  const lastSeen = optionalString(value['last_seen']);
  const source = optionalString(value['source']);
  if ((subject !== undefined && typeof subject !== 'string')
    || (point !== undefined && typeof point !== 'string')
    || (pattern !== undefined && typeof pattern !== 'string')
    || (evidence !== undefined && (typeof evidence !== 'number'
      || !Number.isInteger(evidence) || evidence < 0 || evidence > 0xffffffff))
    || (lastSeen === undefined && value['last_seen'] !== undefined)
    || (source === undefined && value['source'] !== undefined)) return null;
  return {
    subject: subject ?? '',
    knowledge_point: point ?? '',
    error_pattern: pattern ?? '',
    evidence_count: evidence ?? 0,
    last_seen: lastSeen ?? null,
    ...(source === null || source === undefined ? {} : { source }),
  };
}

function parseWeakPointKey(value: unknown): { subject: string; knowledge_point: string } | null {
  if (!isRecord(value)) return null;
  const subject = value['subject'];
  const point = value['knowledge_point'];
  if ((subject !== undefined && typeof subject !== 'string')
    || (point !== undefined && typeof point !== 'string')) return null;
  return { subject: subject ?? '', knowledge_point: point ?? '' };
}

function parseGoals(value: unknown): LearningGoal[] | null {
  if (!Array.isArray(value)) return null;
  const goals: LearningGoal[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const goal = item['goal'];
    const deadline = optionalString(item['deadline']);
    if ((goal !== undefined && typeof goal !== 'string')
      || (deadline === undefined && item['deadline'] !== undefined)) return null;
    goals.push({ goal: goal ?? '', deadline: deadline ?? null });
  }
  return goals;
}

function parsePreferencesPatch(value: unknown): {
  explanation_style: string | null; language: string | null; pace: string | null;
  others_add: string[]; others_remove: string[];
} | null {
  if (!isRecord(value)) return null;
  const explanation = optionalString(value['explanation_style']);
  const language = optionalString(value['language']);
  const pace = optionalString(value['pace']);
  const add = value['others_add'];
  const remove = value['others_remove'];
  if ((explanation === undefined && value['explanation_style'] !== undefined)
    || (language === undefined && value['language'] !== undefined)
    || (pace === undefined && value['pace'] !== undefined)
    || (add !== undefined && (!Array.isArray(add) || add.some(item => typeof item !== 'string')))
    || (remove !== undefined && (!Array.isArray(remove)
      || remove.some(item => typeof item !== 'string')))) return null;
  return {
    explanation_style: explanation ?? null, language: language ?? null, pace: pace ?? null,
    others_add: add === undefined ? [] : [...add as string[]],
    others_remove: remove === undefined ? [] : [...remove as string[]],
  };
}

/** serde `LearnerProfileUpdate` from a JSON value (`null` on any type mismatch). */
export function parseProfileUpdate(value: unknown): LearnerProfileUpdate | null {
  if (!isRecord(value)) return null;
  const weakAdd = value['weak_points_add'];
  const weakRemove = value['weak_points_remove'];
  const goalsAdd = value['goals_add'];
  const goalsRemove = value['goals_remove'];
  const recentStatus = optionalString(value['recent_status']);
  if (weakAdd !== undefined && !Array.isArray(weakAdd)) return null;
  if (weakRemove !== undefined && !Array.isArray(weakRemove)) return null;
  if (goalsAdd !== undefined && !Array.isArray(goalsAdd)) return null;
  if (goalsRemove !== undefined && (!Array.isArray(goalsRemove)
    || goalsRemove.some(item => typeof item !== 'string'))) return null;
  if (recentStatus === undefined && value['recent_status'] !== undefined) return null;

  const addParsed: WeakPoint[] = [];
  for (const item of weakAdd ?? []) {
    const parsed = parseWeakPoint(item);
    if (parsed === null) return null;
    addParsed.push(parsed);
  }
  const removeParsed: { subject: string; knowledge_point: string }[] = [];
  for (const item of weakRemove ?? []) {
    const parsed = parseWeakPointKey(item);
    if (parsed === null) return null;
    removeParsed.push(parsed);
  }
  const goalsAddParsed = goalsAdd === undefined ? [] : parseGoals(goalsAdd);
  if (goalsAddParsed === null) return null;
  let preferences: LearnerProfileUpdate['preferences'] = null;
  if (value['preferences'] !== undefined && value['preferences'] !== null) {
    preferences = parsePreferencesPatch(value['preferences']);
    if (preferences === null) return null;
  }
  return {
    weak_points_add: addParsed,
    weak_points_remove: removeParsed,
    preferences,
    goals_add: goalsAddParsed,
    goals_remove: goalsRemove === undefined ? [] : [...goalsRemove as string[]],
    recent_status: recentStatus ?? null,
  };
}

function decodeUpdate(text: string): LearnerProfileUpdate | null {
  try {
    return parseProfileUpdate(JSON.parse(text));
  } catch (error) {
    return null;
  }
}

/** Code fences/noise tolerated; malformed output must not mark logs as promoted. */
export function parsePromotionResponse(response: string): LearnerProfileUpdate {
  const cleaned = enhancedCleanJsonResponse(response);
  const direct = decodeUpdate(cleaned);
  if (direct !== null) return direct;
  const extracted = extractJsonObject(cleaned);
  const fromCleaned = extracted === null ? null : decodeUpdate(extracted);
  if (fromCleaned !== null) return fromCleaned;
  const rawExtracted = extractJsonObject(response);
  const fromRaw = rawExtracted === null ? null : decodeUpdate(rawExtracted);
  if (fromRaw !== null) return fromRaw;
  // Preserve the explicit empty/refusal inputs supported by the existing parser contract.
  if (response.trim() === '' || response === '模型拒绝回答') return emptyProfileUpdate();
  throw new Error('Invalid memory promotion response');
}

const U64 = (1n << 64n) - 1n;
const rotl = (x: bigint, b: bigint): bigint => ((x << b) | (x >> (64n - b))) & U64;
const STR_TERMINATOR = Uint8Array.of(0xff);

/** std `DefaultHasher::new()`: SipHash-1-3 with zero keys over the written byte stream. */
function sipHash13(bytes: Uint8Array): bigint {
  let v0 = 0x736f6d6570736575n, v1 = 0x646f72616e646f6dn, v2 = 0x6c7967656e657261n, v3 = 0x7465646279746573n;
  const round = (): void => {
    v0 = (v0 + v1) & U64; v1 = rotl(v1, 13n); v1 ^= v0; v0 = rotl(v0, 32n);
    v2 = (v2 + v3) & U64; v3 = rotl(v3, 16n); v3 ^= v2;
    v0 = (v0 + v3) & U64; v3 = rotl(v3, 21n); v3 ^= v0;
    v2 = (v2 + v1) & U64; v1 = rotl(v1, 17n); v1 ^= v2; v2 = rotl(v2, 32n);
  };
  const word = (offset: number, length: number): bigint => {
    let m = 0n;
    for (let i = length - 1; i >= 0; i--) m = (m << 8n) | BigInt(bytes[offset + i]!);
    return m;
  };
  const full = bytes.length - (bytes.length % 8);
  for (let offset = 0; offset < full; offset += 8) {
    const m = word(offset, 8);
    v3 ^= m; round(); v0 ^= m;
  }
  const b = ((BigInt(bytes.length) & 0xffn) << 56n) | word(full, bytes.length - full);
  v3 ^= b; round(); v0 ^= b;
  v2 ^= 0xffn; round(); round(); round();
  return v0 ^ v1 ^ v2 ^ v3;
}

/**
 * Rust `MemoryEvolution::promotion_fingerprint` (evolution.rs:1090): `DefaultHasher` over each log's
 * `date` then `content` (`str::hash` writes the UTF-8 bytes and a `0xFF` terminator), `"{count}:{:x}"`.
 * The value is persisted as the profile's `_promotion_fingerprint`, so it must match Rust bit for bit.
 */
export function promotionFingerprint(logs: readonly Pick<DailyLogRecord, 'date' | 'content'>[]): string {
  const parts: Uint8Array[] = [];
  for (const log of logs) parts.push(encodeUtf8(log.date), STR_TERMINATOR, encodeUtf8(log.content), STR_TERMINATOR);
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return `${logs.length}:${sipHash13(bytes).toString(16)}`;
}
