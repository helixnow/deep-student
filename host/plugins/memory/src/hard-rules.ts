/**
 * L1 Hard Rules pure layer — Hermes `USER.md`-style bounded explicit interaction rules.
 *
 * Rules stored here are guaranteed to be injected into the session-frozen
 * `<memory_kernel>` block from Turn 1 (never relying on probabilistic search).
 * Overflowing the configured character budget raises a hard rejection on tool
 * writes so the agent consolidates or prunes obsolete rules in the same turn.
 */

export const HARD_RULES_NOTE_TITLE = '__memory_hard_rules__';
export const HARD_RULES_DEFAULT_MAX_CHARS = 1500;
export const HARD_RULES_MIN_MAX_CHARS = 800;
export const HARD_RULES_MAX_MAX_CHARS = 3000;
export const MAX_HARD_RULES = 24;
export const MAX_SINGLE_RULE_CHARS = 260;

export const HARD_RULES_MAX_CHARS_CONFIG_KEY = 'hard_rules_max_chars';
export const LEARNER_PROFILE_KERNEL_MAX_CHARS_CONFIG_KEY = 'learner_profile_kernel_max_chars';
export const LEARNER_PROFILE_KERNEL_DEFAULT_MAX_CHARS = 2500;
export const LEARNER_PROFILE_KERNEL_MIN_MAX_CHARS = 1500;
export const LEARNER_PROFILE_KERNEL_MAX_MAX_CHARS = 5000;

export type HardRuleOrigin = 'user_explicit' | 'chat_correction' | 'dialectic_promoted';

export interface MemoryHardRule {
  id: string;
  /** Concrete instruction, e.g. "每次回答结束后附带 1 道变式自测题，先不给答案". */
  instruction: string;
  /** 'global' | 'subject:<name>' | 'mode:<name>'. */
  scope: string;
  origin: HardRuleOrigin;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HardRulesDocument {
  version: number;
  updated_at: string;
  rules: MemoryHardRule[];
}

export interface HardRuleUpsertInput {
  id?: string | null;
  instruction: string;
  scope?: string | null;
  origin?: HardRuleOrigin;
  pinned?: boolean;
}

export function clampHardRulesMaxChars(raw: number | null | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return HARD_RULES_DEFAULT_MAX_CHARS;
  return Math.max(HARD_RULES_MIN_MAX_CHARS, Math.min(HARD_RULES_MAX_MAX_CHARS, Math.floor(raw)));
}

export function clampLearnerProfileKernelMaxChars(raw: number | null | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return LEARNER_PROFILE_KERNEL_DEFAULT_MAX_CHARS;
  return Math.max(LEARNER_PROFILE_KERNEL_MIN_MAX_CHARS, Math.min(LEARNER_PROFILE_KERNEL_MAX_MAX_CHARS, Math.floor(raw)));
}

export function emptyHardRules(): HardRulesDocument {
  return { version: 0, updated_at: '', rules: [] };
}

export function normalizeRuleScope(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim().toLowerCase();
  if (trimmed === '' || trimmed === 'global' || trimmed === 'all' || trimmed === '*') return 'global';
  if (trimmed.startsWith('subject:') || trimmed.startsWith('mode:')) {
    const rest = trimmed.slice(trimmed.indexOf(':') + 1).trim();
    return rest === '' ? 'global' : `${trimmed.slice(0, trimmed.indexOf(':') + 1)}${rest}`;
  }
  return `subject:${trimmed}`;
}

export function normalizeRuleInstruction(raw: string): string {
  return raw.replace(/\r\n|\r/g, '\n').replace(/\s+/g, ' ').trim();
}

export function ruleCharLength(text: string): number {
  return Array.from(text).length;
}

function isOrigin(value: unknown): value is HardRuleOrigin {
  return value === 'user_explicit' || value === 'chat_correction' || value === 'dialectic_promoted';
}

export function hardRulesFromJson(json: string): HardRulesDocument | null {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return null; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const version = typeof obj.version === 'number' && Number.isInteger(obj.version) && obj.version >= 0
    ? obj.version : 0;
  const updated_at = typeof obj.updated_at === 'string' ? obj.updated_at : '';
  const rawRules = Array.isArray(obj.rules) ? obj.rules : [];
  const rules: MemoryHardRule[] = [];
  const seenIds = new Set<string>();
  for (const item of rawRules) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === 'string' ? rec.id.trim() : '';
    const instruction = typeof rec.instruction === 'string' ? normalizeRuleInstruction(rec.instruction) : '';
    if (id === '' || instruction === '' || seenIds.has(id)) continue;
    seenIds.add(id);
    rules.push({
      id,
      instruction,
      scope: normalizeRuleScope(typeof rec.scope === 'string' ? rec.scope : 'global'),
      origin: isOrigin(rec.origin) ? rec.origin : 'user_explicit',
      pinned: rec.pinned === true,
      createdAt: typeof rec.createdAt === 'string' ? rec.createdAt : updated_at,
      updatedAt: typeof rec.updatedAt === 'string' ? rec.updatedAt : updated_at,
    });
  }
  return { version, updated_at, rules };
}

export function hardRulesToJson(doc: HardRulesDocument): string {
  return JSON.stringify(doc, null, 2);
}

/**
 * Upserts a rule by id (or case-insensitive instruction + scope match).
 * Returns `{ doc, rule, changed }`.
 */
export function upsertHardRule(
  current: HardRulesDocument,
  input: HardRuleUpsertInput,
  nowRfc3339: string,
  generateId: () => string,
): { doc: HardRulesDocument; rule: MemoryHardRule; changed: boolean } {
  const instruction = normalizeRuleInstruction(input.instruction);
  if (instruction === '') {
    throw new Error('Invalid hard rule: instruction must not be empty');
  }
  if (ruleCharLength(instruction) > MAX_SINGLE_RULE_CHARS) {
    throw new Error(`Invalid hard rule: single rule exceeds ${MAX_SINGLE_RULE_CHARS} chars`);
  }
  const scope = normalizeRuleScope(input.scope);
  const origin: HardRuleOrigin = input.origin ?? 'user_explicit';
  const rules = current.rules.map(r => ({ ...r }));

  const targetId = input.id?.trim() || null;
  let existingIndex = targetId !== null ? rules.findIndex(r => r.id === targetId) : -1;
  if (existingIndex === -1) {
    const lower = instruction.toLowerCase();
    existingIndex = rules.findIndex(r => r.scope === scope && r.instruction.toLowerCase() === lower);
  }

  if (existingIndex !== -1) {
    const prev = rules[existingIndex]!;
    const nextPinned = input.pinned !== undefined ? input.pinned : prev.pinned;
    const nextOrigin = input.origin !== undefined ? input.origin : prev.origin;
    const same = prev.instruction === instruction
      && prev.scope === scope
      && prev.pinned === nextPinned
      && prev.origin === nextOrigin;
    if (same) {
      return { doc: current, rule: prev, changed: false };
    }
    const updated: MemoryHardRule = {
      ...prev,
      instruction,
      scope,
      origin: nextOrigin,
      pinned: nextPinned,
      updatedAt: nowRfc3339,
    };
    rules[existingIndex] = updated;
    return {
      doc: { version: current.version + 1, updated_at: nowRfc3339, rules },
      rule: updated,
      changed: true,
    };
  }

  const created: MemoryHardRule = {
    id: targetId ?? generateId(),
    instruction,
    scope,
    origin,
    pinned: input.pinned ?? (origin === 'user_explicit'),
    createdAt: nowRfc3339,
    updatedAt: nowRfc3339,
  };
  rules.push(created);
  return {
    doc: { version: current.version + 1, updated_at: nowRfc3339, rules },
    rule: created,
    changed: true,
  };
}

export function removeHardRule(
  current: HardRulesDocument,
  idOrInstruction: string,
  nowRfc3339: string,
): { doc: HardRulesDocument; removed: MemoryHardRule | null } {
  const needle = idOrInstruction.trim();
  if (needle === '') return { doc: current, removed: null };
  const lower = needle.toLowerCase();
  const idx = current.rules.findIndex(r => r.id === needle || r.instruction.toLowerCase() === lower);
  if (idx === -1) return { doc: current, removed: null };
  const rules = current.rules.map(r => ({ ...r }));
  const [removed] = rules.splice(idx, 1);
  return {
    doc: { version: current.version + 1, updated_at: nowRfc3339, rules },
    removed: removed ?? null,
  };
}

/** Filters rules applicable to a session's optional subject / mode (always includes 'global'). */
export function filterHardRulesForScope(
  rules: readonly MemoryHardRule[],
  filter?: { subject?: string | null; mode?: string | null },
): MemoryHardRule[] {
  const subjectKey = filter?.subject?.trim() ? `subject:${filter.subject.trim().toLowerCase()}` : null;
  const modeKey = filter?.mode?.trim() ? `mode:${filter.mode.trim().toLowerCase()}` : null;
  const matched = rules.filter(r =>
    r.scope === 'global'
    || (subjectKey !== null && r.scope === subjectKey)
    || (modeKey !== null && r.scope === modeKey));
  // Pinned & user_explicit rules come first, then newest updatedAt.
  return matched.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const rank = (origin: HardRuleOrigin) => (origin === 'user_explicit' ? 0 : origin === 'chat_correction' ? 1 : 2);
    const rDiff = rank(a.origin) - rank(b.origin);
    if (rDiff !== 0) return rDiff;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

export function renderHardRules(rules: readonly MemoryHardRule[]): string {
  if (rules.length === 0) return '';
  const lines = rules.map(rule => {
    const scopeTag = rule.scope === 'global' ? '' : `[${rule.scope}] `;
    const pinTag = rule.pinned ? '[必遵] ' : '';
    return `- ${pinTag}${scopeTag}${rule.instruction} (id:${rule.id})`;
  });
  return `## 互动硬性规则（从第 1 轮起 100% 严格遵循）\n${lines.join('\n')}`;
}

export function renderedHardRulesCharCount(doc: HardRulesDocument): number {
  return ruleCharLength(renderHardRules(doc.rules));
}

/** Drops lowest-priority unpinned rules when `limitPolicy === 'enforce'` exceeds budget. */
export function enforceHardRulesCharLimit(doc: HardRulesDocument, maxChars: number): HardRulesDocument {
  let rules = [...doc.rules];
  // Enforce count ceiling first, dropping oldest unpinned first.
  const dropOne = () => {
    let victimIdx = -1;
    for (let i = rules.length - 1; i >= 0; i -= 1) {
      if (!rules[i]!.pinned) { victimIdx = i; break; }
    }
    if (victimIdx === -1) victimIdx = rules.length - 1;
    rules.splice(victimIdx, 1);
  };
  while (rules.length > MAX_HARD_RULES) dropOne();
  while (rules.length > 0 && ruleCharLength(renderHardRules(rules)) > maxChars) {
    dropOne();
  }
  return { ...doc, rules };
}

/**
 * Computes a compact mid-session `<memory_delta>` for rules modified after the
 * session snapshot was frozen, so new rules take effect immediately without
 * mutating the frozen `stableSystem` prompt prefix.
 */
export function buildHardRulesDelta(
  currentRules: readonly MemoryHardRule[],
  frozenRuleIds: readonly string[],
  frozenAt: string,
): string | null {
  const frozenSet = new Set(frozenRuleIds);
  const currentSet = new Set(currentRules.map(r => r.id));
  const addedOrUpdated = currentRules.filter(r => !frozenSet.has(r.id) || (frozenAt !== '' && r.updatedAt > frozenAt));
  const removedIds = frozenRuleIds.filter(id => !currentSet.has(id));
  if (addedOrUpdated.length === 0 && removedIds.length === 0) return null;

  const lines: string[] = [];
  for (const r of addedOrUpdated) {
    const scopeTag = r.scope === 'global' ? '' : `[${r.scope}] `;
    lines.push(`+ 新增/更新规则：${scopeTag}${r.instruction} (id:${r.id})`);
  }
  if (removedIds.length > 0) {
    lines.push(`- 已移除旧规则 id：${removedIds.join(', ')}`);
  }
  return lines.join('\n');
}
