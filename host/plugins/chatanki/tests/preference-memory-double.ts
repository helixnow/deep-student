// L16 `anki_preference_memory` surrogate: only the deterministic
// extract → consolidate subset exercised by the L24 persistence contract tests.
// When L16 publishes the preference-memory service, swap this double for the real
// implementation; the assertions stay unchanged.
import type {
  ChatAnkiCardEditObservation, ChatAnkiConsolidateOutcome, ChatAnkiPreferenceEntry,
  ChatAnkiPreferenceKind, ChatAnkiPreferenceMemory, ChatAnkiPreferenceStore, ChatAnkiPreferenceTimestamp,
  ChatAnkiSessionObservation,
} from '../api.ts';

const CONFIDENCE_CAP = 0.95;
const LANGUAGE_SHIFT_THRESHOLD = 0.25;
const DELETION_DENSITY_THRESHOLD = 0.3;
const DELETION_MIN_GENERATED = 5;
const MAX_STORE_ENTRIES = 64;

interface Candidate {
  kind: ChatAnkiPreferenceKind;
  statement: string;
  subject: string | null;
  confidence: number;
  evidence: string;
}

function isCjk(code: number): boolean {
  return code >= 0x4e00 && code <= 0x9fff
    || code >= 0x3400 && code <= 0x4dbf
    || code >= 0xf900 && code <= 0xfaff
    || code >= 0x3040 && code <= 0x30ff;
}

function cjkRatio(text: string): number {
  let cjk = 0;
  let total = 0;
  for (const char of text) {
    if (/\s/u.test(char)) continue;
    total += 1;
    if (isCjk(char.codePointAt(0) ?? 0)) cjk += 1;
  }
  return total === 0 ? 0 : cjk / total;
}

function extractFromExtraRequirements(
  raw: string, out: Candidate[],
): void {
  const text = raw.trim();
  if (text.length === 0) return;
  const lower = text.toLowerCase();
  const containsAny = (needles: readonly string[]): boolean =>
    needles.some((needle) => lower.includes(needle));
  const wantsZh = containsAny([
    '用中文', '中文回答', '中文作答', '答案用中文', '中文解释', 'in chinese',
  ]);
  const wantsEn = containsAny(['用英文', '英文回答', '英文作答', '全英文', 'in english']);
  if (wantsZh !== wantsEn) {
    out.push(wantsZh
      ? {
        kind: 'language', statement: '卡片正文与答案使用中文书写', subject: 'zh',
        confidence: 0.9, evidence: 'extraRequirements 显式指定语言',
      }
      : {
        kind: 'language', statement: '卡片正文与答案使用英文书写', subject: 'en',
        confidence: 0.9, evidence: 'extraRequirements 显式指定语言',
      });
  }
  if (containsAny([
    '不要翻译', '不翻译', '禁止翻译', '保留英文', '保留原文', '保留术语', '术语不译',
    'do not translate', "don't translate", 'keep the original', 'keep original',
  ])) {
    out.push({
      kind: 'no_translation', statement: '专业术语保留原文，不要翻译', subject: null,
      confidence: 0.9, evidence: 'extraRequirements 显式要求不翻译/保留原文',
    });
  }
  const numericLimit = /(?:最多|不超过)\s*(\d{1,3})\s*张/u.exec(lower)
    ?? /(?:at most|no more than|max(?:imum)?(?: of)?)\s*(\d{1,3})\s*cards?/u.exec(lower);
  if (numericLimit !== null) {
    const limit = numericLimit[1] ?? '';
    out.push({
      kind: 'card_density', statement: `控制卡片数量：每份材料不超过 ${limit} 张`,
      subject: limit, confidence: 0.9, evidence: 'extraRequirements 显式限制卡片数量',
    });
  } else if (containsAny(['少而精', '宁缺毋滥', '不要太多卡', '卡片少一点', 'fewer cards'])) {
    out.push({
      kind: 'card_density',
      statement: '控制卡片密度：少而精，避免把同一知识点拆成大量浅层卡片',
      subject: null, confidence: 0.85,
      evidence: 'extraRequirements 表达了少而精的密度倾向',
    });
  }
}

function extractFromEdits(edits: readonly ChatAnkiCardEditObservation[], out: Candidate[]): void {
  let toZh = 0;
  let toEn = 0;
  for (const edit of edits) {
    const before = edit.before.trim();
    const after = edit.after.trim();
    if (before.length === 0 || after.length === 0 || before === after) continue;
    const delta = cjkRatio(after) - cjkRatio(before);
    if (delta >= LANGUAGE_SHIFT_THRESHOLD) toZh += 1;
    else if (delta <= -LANGUAGE_SHIFT_THRESHOLD) toEn += 1;
  }
  if (toZh >= 2 && toZh > toEn) {
    out.push({
      kind: 'language', statement: '卡片正文与答案使用中文书写', subject: 'zh',
      confidence: Math.min(0.75, 0.55 + 0.05 * (toZh - 2)),
      evidence: `用户 ${toZh} 次将卡片内容改写为中文`,
    });
  } else if (toEn >= 2 && toEn > toZh) {
    out.push({
      kind: 'language', statement: '卡片正文与答案使用英文书写', subject: 'en',
      confidence: Math.min(0.75, 0.55 + 0.05 * (toEn - 2)),
      evidence: `用户 ${toEn} 次将卡片内容改写为英文`,
    });
  }
}

function extractFromDeletions(
  observation: ChatAnkiSessionObservation, out: Candidate[],
): void {
  if (observation.generatedCount < DELETION_MIN_GENERATED
    || observation.deletions.length === 0) return;
  const ratio = observation.deletions.length / observation.generatedCount;
  if (ratio < DELETION_DENSITY_THRESHOLD) return;
  out.push({
    kind: 'card_density',
    statement: '控制卡片密度：少而精，避免把同一知识点拆成大量浅层卡片',
    subject: null,
    confidence: Math.min(0.85, 0.5 + ratio * 0.3),
    evidence: `用户删除了 ${observation.deletions.length}/${observation.generatedCount} 张生成卡`,
  });
}

function extractPreferences(observation: ChatAnkiSessionObservation): Candidate[] {
  const out: Candidate[] = [];
  if (observation.extraRequirements !== null) {
    extractFromExtraRequirements(observation.extraRequirements, out);
  }
  extractFromEdits(observation.edits, out);
  extractFromDeletions(observation, out);
  if (observation.templateUsed !== null) {
    const name = observation.templateUsed.trim();
    if (name.length > 0 && !out.some((candidate) => candidate.kind === 'template_preference')) {
      out.push({
        kind: 'template_preference', statement: `优先使用「${name}」模板`, subject: name,
        confidence: 0.6, evidence: '用户在本会话主动选用了该模板',
      });
    }
  }
  return out;
}

function normalizeForKey(value: string): string {
  return [...value]
    .filter((char) => !/\s/u.test(char) && !'，。、；;：:！!？?「」“”"\'（）()'.includes(char))
    .join('')
    .toLowerCase();
}

function normalizedKey(
  kind: ChatAnkiPreferenceKind, statement: string, subject: string | null,
): string {
  return `${kind}|${normalizeForKey(statement)}|${subject === null ? '' : normalizeForKey(subject)}`;
}

function entryScore(entry: ChatAnkiPreferenceEntry): number {
  return entry.confidence * (1 + Math.log1p(entry.evidence_count));
}

/** Mirrors dstu-anki `consolidate`: ADD-only, duplicate observations reinforce. */
export class PreferenceMemoryDouble implements ChatAnkiPreferenceMemory {
  emptyStore(): ChatAnkiPreferenceStore {
    return { entries: [] };
  }

  consolidateObservation(
    store: ChatAnkiPreferenceStore,
    observation: ChatAnkiSessionObservation,
    nowMs: ChatAnkiPreferenceTimestamp,
  ): ChatAnkiConsolidateOutcome {
    const outcome: ChatAnkiConsolidateOutcome = { added: [], reinforced: [], evicted: [] };
    for (const candidate of extractPreferences(observation)) {
      const key = normalizedKey(candidate.kind, candidate.statement, candidate.subject);
      const existing = store.entries.find((entry) =>
        normalizedKey(entry.kind, entry.statement, entry.subject) === key);
      if (existing !== undefined) {
        existing.evidence_count += 1;
        existing.confidence = Math.min(
          CONFIDENCE_CAP, Math.max(existing.confidence, candidate.confidence) + 0.05,
        );
        existing.last_evidence = candidate.evidence;
        existing.last_seen_ms = nowMs;
        outcome.reinforced.push(existing.statement);
      } else {
        store.entries.push({
          kind: candidate.kind,
          statement: candidate.statement,
          subject: candidate.subject,
          confidence: Math.min(CONFIDENCE_CAP, candidate.confidence),
          evidence_count: 1,
          last_evidence: candidate.evidence,
          first_seen_ms: nowMs,
          last_seen_ms: nowMs,
        });
        outcome.added.push(candidate.statement);
      }
    }
    while (store.entries.length > MAX_STORE_ENTRIES) {
      let lowestIndex = 0;
      for (let index = 1; index < store.entries.length; index += 1) {
        const candidate = store.entries[index];
        const lowest = store.entries[lowestIndex];
        if (candidate === undefined || lowest === undefined) continue;
        const delta = entryScore(candidate) - entryScore(lowest);
        if (delta < 0 || delta === 0 && candidate.last_seen_ms < lowest.last_seen_ms) {
          lowestIndex = index;
        }
      }
      const [removed] = store.entries.splice(lowestIndex, 1);
      if (removed !== undefined) outcome.evicted.push(removed.statement);
    }
    return outcome;
  }
}
