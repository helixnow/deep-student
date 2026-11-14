/** Rust insight/disclosure.rs: pure policy gate, no database and no events. */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { getSetting, sumInsightLedger } from '../repository/insight.ts';

export type DisclosureLevel = 'hidden' | 'existence' | 'recall_prompt' | 'hint' | 'full' | 'direct_answer';
export type SilenceReason = 'no_match' | 'low_confidence' | 'budget' | 'user_disabled';
export type DisclosureOutcome =
  | { kind: 'disclose'; level: DisclosureLevel }
  | { kind: 'silence'; reason: SilenceReason };
export interface DisclosurePolicy {
  enabled: boolean;
  max_per_turn: number;
  min_confidence: number;
  passive_max_level: DisclosureLevel;
}
export interface ScoredRef { confidence: number }

export function defaultDisclosurePolicy(): DisclosurePolicy {
  return { enabled: true, max_per_turn: 2, min_confidence: 0.35, passive_max_level: 'existence' };
}
/** Rust `DisclosureLevel` Ord: hidden < existence < recall_prompt < hint < full < direct_answer. */
export function disclosureRank(level: DisclosureLevel): number {
  return ['hidden', 'existence', 'recall_prompt', 'hint', 'full', 'direct_answer'].indexOf(level);
}

/** Rust `load_policy`: missing/failed reads fall back per field; passive level stays default. */
export function loadPolicy(mainDb: SqlExecutor | null): DisclosurePolicy {
  const fallback = defaultDisclosurePolicy();
  if (mainDb === null) return fallback;
  const read = (key: string): string | null => {
    try {
      const value = getSetting(mainDb, key);
      return typeof value === 'string' ? value : null;
    } catch (error) {
      // Rust `db.get_conn_safe().ok()?`: connection failures read as a missing setting.
      return null;
    }
  };
  const rawMax = read('insight.recall.max_per_turn');
  const max = rawMax === null ? null : parseUnsigned(rawMax);
  const rawMin = read('insight.recall.min_confidence');
  const enabledValue = read('insight.recall.enabled');
  return {
    enabled: enabledValue === null ? fallback.enabled : enabledValue !== 'false' && enabledValue !== '0',
    max_per_turn: max ?? fallback.max_per_turn,
    min_confidence: rawMin === null ? fallback.min_confidence : parseRustF64(rawMin) ?? fallback.min_confidence,
    passive_max_level: fallback.passive_max_level,
  };
}
/** Rust `str::parse::<usize>()`: ASCII digits only; overflow rejected without wrapping. */
function parseUnsigned(text: string): number | null {
  if (!/^\d+$/.test(text)) return null;
  const value = BigInt(text);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}
/** Rust f64 FromStr accepts inf/NaN spellings. */
function parseRustF64(text: string): number | null {
  if (/^[+-]?inf(inity)?$/i.test(text)) return text.startsWith('-') ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(text)) return NaN;
  return /^[+-]?(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)$/.test(text) ? Number(text) : null;
}

export function decidePassive(policy: DisclosurePolicy, candidates: readonly ScoredRef[]): DisclosureOutcome[] {
  if (!policy.enabled) return candidates.map(() => ({ kind: 'silence', reason: 'user_disabled' }));
  let shown = 0;
  return candidates.map(candidate => {
    if (candidate.confidence < policy.min_confidence) return { kind: 'silence', reason: 'low_confidence' };
    if (shown >= policy.max_per_turn) return { kind: 'silence', reason: 'budget' };
    shown += 1;
    return { kind: 'disclose', level: policy.passive_max_level };
  });
}

export function decideEscalation(policy: DisclosurePolicy, current: DisclosureLevel, requested: DisclosureLevel): DisclosureOutcome {
  if (!policy.enabled) return { kind: 'silence', reason: 'user_disabled' };
  if (disclosureRank(requested) <= disclosureRank(current)) return { kind: 'disclose', level: current };
  const ladder: DisclosureLevel[] = ['hidden', 'existence', 'recall_prompt', 'hint', 'full'];
  const granted: DisclosureLevel = requested === 'direct_answer'
    ? 'direct_answer'
    : ladder[Math.min(4, disclosureRank(current) + 1)]!;
  return { kind: 'disclose', level: granted };
}

export function calibratePolicyFromLedger(conn: SqlExecutor, policy: DisclosurePolicy): DisclosurePolicy {
  const MIN_SAMPLE = 10;
  let row: { shown: number; useful: number } | undefined;
  try {
    row = sumInsightLedger(conn);
  } catch {
    return policy;
  }
  if (row === undefined || row.shown < MIN_SAMPLE) return policy;
  const usefulRate = row.useful / row.shown;
  const delta = (0.5 - usefulRate) * 0.3;
  return { ...policy, min_confidence: Math.min(0.8, Math.max(0.15, policy.min_confidence + delta)) };
}

export function internalizationDiscount(recallCount: number, shownCount: number, usefulCount: number): number {
  if (recallCount < 5) return 1;
  const usefulRate = shownCount > 0 ? usefulCount / shownCount : 0;
  if (usefulRate < 0.5) return 1;
  const factor = 1 - 0.07 * Math.max(0, recallCount - 4);
  return Math.min(1, Math.max(0.3, factor));
}

export function filterContent(level: DisclosureLevel, title: string, situation: string, rule: string):
  [title: string, situation: string | null, rule: string | null] {
  if (level === 'hidden' || level === 'existence') return [title, null, null];
  if (level === 'recall_prompt') return [title, situation, null];
  return [title, situation, rule];
}
