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

const GLOBAL_SCOPE_ALIASES = new Set([
  '',
  'global',
  'all',
  '*',
  'general',
  'default',
  'everywhere',
  'everything',
  'all subjects',
  '全局',
  '全学科',
  '通用',
  'すべて',
  'tous',
  'alle',
  'todos',
]);

/**
 * Returns true when `text` is predominantly Chinese (Han script without Japanese kana
 * or Korean hangul). Used to choose localized vs. language-neutral memory framing
 * without hardcoding to a single non-Chinese language.
 */
export function isChineseDominantText(text: string): boolean {
  const hanCount = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  if (hanCount === 0) return false;
  if (/[\u3040-\u30ff\uac00-\ud7af]/.test(text)) return false;
  const totalLetters = (text.match(/\p{L}/gu) ?? []).length;
  const nonHanLetters = Math.max(0, totalLetters - hanCount);
  // Han characters carry higher information density per codepoint than alphabetic scripts.
  return hanCount * 2.5 >= nonHanLetters;
}

export function normalizeRuleScope(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim().replaceAll('：', ':').toLowerCase();
  if (GLOBAL_SCOPE_ALIASES.has(trimmed)) return 'global';
  if (trimmed.startsWith('学科:')) {
    const rest = trimmed.slice('学科:'.length).trim();
    return GLOBAL_SCOPE_ALIASES.has(rest) ? 'global' : `subject:${rest}`;
  }
  if (trimmed.startsWith('模式:')) {
    const rest = trimmed.slice('模式:'.length).trim();
    return GLOBAL_SCOPE_ALIASES.has(rest) ? 'global' : `mode:${rest}`;
  }
  if (trimmed.startsWith('subject:') || trimmed.startsWith('mode:')) {
    const colon = trimmed.indexOf(':');
    const rest = trimmed.slice(colon + 1).trim();
    return GLOBAL_SCOPE_ALIASES.has(rest) ? 'global' : `${trimmed.slice(0, colon + 1)}${rest}`;
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
  const matched = rules.filter((r) => {
    const normalized = normalizeRuleScope(r.scope);
    return normalized === 'global'
      || (subjectKey !== null && normalized === subjectKey)
      || (modeKey !== null && normalized === modeKey);
  });
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
  const chinese = isChineseDominantText(rules.map(r => `${r.instruction} ${r.scope}`).join(' '));
  const lines = rules.map(rule => {
    const scopeTag = rule.scope === 'global' ? '' : `[${rule.scope}] `;
    const pinTag = rule.pinned ? (chinese ? '[必遵] ' : '[REQUIRED] ') : '';
    return `- ${pinTag}${scopeTag}${rule.instruction} (id:${rule.id})`;
  });
  const heading = chinese
    ? '## 互动硬性规则（规范格式与语气，不得遗漏任何子问题）'
    : '## Hard Interaction Rules (govern format/tone per part; never omit any sub-question)';
  return `${heading}\n${lines.join('\n')}`;
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

export interface FrozenRuleSnapshotRef {
  id: string;
  instruction: string;
  scope?: string;
}

/**
 * Computes a compact mid-session `<memory_delta>` for rules modified after the
 * session snapshot was frozen, so additions, edits, and explicit revocations
 * take effect immediately without mutating the frozen `stableSystem` prefix.
 */
export function buildHardRulesDelta(
  currentRules: readonly MemoryHardRule[],
  frozenRuleIds: readonly string[],
  frozenAt: string,
  frozenRules?: readonly FrozenRuleSnapshotRef[],
): string | null {
  const frozenSet = new Set(frozenRuleIds);
  const currentSet = new Set(currentRules.map(r => r.id));
  const frozenById = new Map<string, FrozenRuleSnapshotRef>();
  for (const r of frozenRules ?? []) {
    frozenById.set(r.id, r);
  }
  const addedOrUpdated = currentRules.filter(r => !frozenSet.has(r.id) || (frozenAt !== '' && r.updatedAt > frozenAt));
  const removedIds = frozenRuleIds.filter(id => !currentSet.has(id));
  if (addedOrUpdated.length === 0 && removedIds.length === 0) return null;

  const sampleText = [
    ...addedOrUpdated.map(r => `${r.instruction} ${r.scope}`),
    ...removedIds.map(id => frozenById.get(id)?.instruction ?? ''),
    ...currentRules.map(r => r.instruction),
  ].join(' ');
  const chinese = isChineseDominantText(sampleText);

  const lines: string[] = [];
  for (const r of addedOrUpdated) {
    const scopeTag = r.scope === 'global' ? '' : `[${r.scope}] `;
    lines.push(chinese
      ? `+ 新增/更新规则：${scopeTag}${r.instruction} (id:${r.id})`
      : `+ Added/updated rule: ${scopeTag}${r.instruction} (id:${r.id})`);
  }
  for (const id of removedIds) {
    const prev = frozenById.get(id);
    if (prev?.instruction) {
      const scopeTag = prev.scope && prev.scope !== 'global' ? `[${prev.scope}] ` : '';
      const prevChinese = isChineseDominantText(prev.instruction);
      lines.push(prevChinese
        ? `- 【已作废/撤回，立即停止执行】用户已删除规则「${scopeTag}${prev.instruction}」(id:${id})，从本轮起严禁再套用。`
        : `- [REVOKED - STOP IMMEDIATELY] User deleted rule "${scopeTag}${prev.instruction}" (id:${id}); stop applying it from this turn onward.`);
    } else {
      lines.push(chinese
        ? `- 【已作废/撤回，立即停止执行】已移除旧规则 id：${id}`
        : `- [REVOKED - STOP IMMEDIATELY] Removed rule id: ${id}`);
    }
  }
  return lines.join('\n');
}
