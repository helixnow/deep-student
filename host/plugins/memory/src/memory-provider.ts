/**
 * Pluggable `MemoryProvider` interface and default `LocalMemoryProvider` (`dstu.memory.local`).
 *
 * Bridges RFC-001 (Memory System v2) and RFC-002 (Plugin System v2 Tier 3 `provider:memory`):
 * - `buildSessionSnapshot` produces a bounded, session-frozen `<memory_kernel>` injected once
 *   in `stableSystem` (eliminating N× per-turn profile duplication while guaranteeing Turn-1
 *   adherence to HardRules).
 * - `buildSessionDelta` produces a tiny `<memory_delta>` block only when rules or profile
 *   changed mid-session, preserving prefix Prompt Cache byte stability.
 * - `inspect` / `mutateFromUser` power the dual-zone transparent MemoryView UI.
 */
import { chronoRfc3339 } from '../../../platform/time/index.ts';
import type { MemoryListItem } from '../api.ts';
import {
  buildHardRulesDelta, clampHardRulesMaxChars, clampLearnerProfileKernelMaxChars,
  filterHardRulesForScope, HARD_RULES_MAX_CHARS_CONFIG_KEY, isChineseDominantText,
  LEARNER_PROFILE_KERNEL_MAX_CHARS_CONFIG_KEY, renderHardRules, renderedHardRulesCharCount,
  ruleCharLength, type FrozenRuleSnapshotRef, type HardRuleUpsertInput, type HardRulesDocument, type MemoryHardRule,
} from './hard-rules.ts';
import {
  emptyProfile, emptyProfileUpdate, isProfileContentEmpty, renderLearnerProfile, renderedCharCount,
  type LearnerPreferences, type LearnerProfile, type LearnerProfileUpdate,
} from './learner-profile.ts';
import type { ProfileUpdateOptions } from './profile-store.ts';
import {
  detectTextContradiction, filterProfileForActiveHardRules, runDialecticReflection,
  type DialecticReflectionReport,
} from './dialectic-reflection.ts';

export type { DialecticProposal, DialecticProposalKind, DialecticReflectionReport } from './dialectic-reflection.ts';

export const LOCAL_MEMORY_PROVIDER_ID = 'dstu.memory.local';
const MAX_KERNEL_WEAK_POINTS = 12;
const MAX_LEGACY_BRIDGE_NOTES = 6;
const MAX_LEGACY_BRIDGE_CHARS = 900;
const MAX_LEGACY_BRIDGE_SCAN_NOTES = 30;
const LEGACY_BRIDGE_HEADING_ZH = '## 用户已记录的核心记忆与互动偏好（请从第 1 轮起主动结合并严格遵循其中的互动要求）';
const LEGACY_BRIDGE_HEADING_NEUTRAL = '## Recorded Core Memories & Interaction Preferences (apply from Turn 1; superseded by contradicting L1 Hard Rules)';
const LEGACY_PREFERENCE_BRIDGE_RE = /(?:偏好|风格|习惯|每次|固定|必须|不要|思考题|自测|类比|薄弱|偏弱|弱项|工科|理科|文科|背景|请|记住|务必|喜欢|擅长|目标|考研|雅思|托福|本科|大一|大二|大三|大四|高一|高二|高三|先给|引导|提示|prefer(?:ence|s)?|style|habit|format|always|never|avoid|must|bullet|table|prose|concise|brief|detailed|analog(?:y|ies)|weak(?:ness)?|strength|major|undergrad|graduate|student|exam|goal|remember|please|quiz|self-?check|hint|socratic|tone|language|pace|background|engineering|science|humanities|préf|toujours|jamais|immer|niemals|siempre|nunca|好み|必ず|毎回|선호|항상)/i;

export interface SessionSnapshotRequest {
  sessionId: string;
  memoryEnabled?: boolean | null;
  subject?: string | null;
  mode?: string | null;
}

export interface MemorySessionSnapshot {
  providerId: string;
  /** Rendered Markdown body placed inside `<memory_kernel>...</memory_kernel>`. Empty string when disabled/empty. */
  renderedKernel: string;
  rulesVersion: number;
  profileVersion: number;
  includedRuleIds: string[];
  includedRules?: FrozenRuleSnapshotRef[];
  includedWeakPointKeys: string[];
  includedPreferences?: LearnerPreferences;
  includedLegacyNoteIds: string[];
  charCount: number;
  maxChars: number;
  snapshotAt: string;
  generation: number;
}

export interface MemoryBudgetSnapshot {
  rulesChars: number;
  rulesMaxChars: number;
  profileChars: number;
  profileMaxChars: number;
}

export interface MemoryInspectionView {
  providerId: string;
  privacyMode: boolean;
  hardRules: HardRulesDocument;
  learnerProfile: LearnerProfile;
  profileHistory: LearnerProfile[];
  renderedKernelPreview: string;
  budgets: MemoryBudgetSnapshot;
}

export type UserMemoryMutation =
  | { kind: 'upsert_rule'; input: HardRuleUpsertInput }
  | { kind: 'remove_rule'; idOrInstruction: string }
  | { kind: 'update_profile'; update: LearnerProfileUpdate }
  | { kind: 'rollback_profile'; targetVersion: number }
  | { kind: 'set_budgets'; rulesMaxChars?: number; profileMaxChars?: number };

export type LearningSignal =
  | {
    kind: 'fsrs_review';
    subject?: string | null;
    concept: string;
    rating: 1 | 2 | 3 | 4;
    stabilityDays: number;
    lapsed: boolean;
    cardId: string;
  }
  | {
    kind: 'qbank_attempt';
    subject?: string | null;
    knowledgePoint: string;
    correct: boolean;
    errorTag?: string | null;
    questionId: string;
  }
  | {
    kind: 'essay_graded';
    examType: string;
    rubricDimensions: Array<{ name: string; score: number; maxScore: number; recurringIssue?: string | null }>;
    essayId: string;
    locale?: string | null;
  }
  | {
    kind: 'chat_correction';
    ruleOrFeedback: string;
    subject?: string | null;
    sessionId: string;
  }
  | {
    kind: 'study_artifact_friction';
    source: 'pdf' | 'media' | 'notes';
    concept: string;
    detail: string;
  };

export interface MemoryProvider {
  readonly id: string;
  buildSessionSnapshot(req: SessionSnapshotRequest): MemorySessionSnapshot;
  buildSessionDelta(req: SessionSnapshotRequest, frozen: MemorySessionSnapshot): string | null;
  ingestSignal(signal: LearningSignal): void;
  inspect(): MemoryInspectionView;
  mutateFromUser(mutation: UserMemoryMutation): MemoryInspectionView;
  reflect?(): DialecticReflectionReport;
}

/** Narrow host port consumed by `LocalMemoryProvider` (implemented by `MemoryServiceImpl`). */
export interface LocalMemoryProviderHost {
  isPrivacyMode(): boolean;
  getRootFolderId(): string | null;
  loadHardRules(): HardRulesDocument;
  upsertHardRule(
    input: HardRuleUpsertInput,
    options: Pick<ProfileUpdateOptions, 'source' | 'sessionId' | 'reason' | 'limitPolicy'>,
  ): { doc: HardRulesDocument; rule: MemoryHardRule; changed: boolean };
  removeHardRule(
    idOrInstruction: string,
    options: Pick<ProfileUpdateOptions, 'source' | 'sessionId' | 'reason'>,
  ): { doc: HardRulesDocument; removed: MemoryHardRule | null };
  getHardRulesMaxChars(): number;
  getLearnerProfileKernelMaxChars(): number;
  setConfigValue(key: string, value: string): void;
  loadProfile(): LearnerProfile | null;
  loadProfileHistory(): LearnerProfile[];
  applyProfileUpdate(update: LearnerProfileUpdate, options: ProfileUpdateOptions): { profile: LearnerProfile; changed: boolean };
  rollbackProfileToVersion(
    targetVersion: number,
    options: Pick<ProfileUpdateOptions, 'source' | 'sessionId' | 'reason'>,
  ): { profile: LearnerProfile; changed: boolean };
  list(folderPath?: string | null): MemoryListItem[];
  read(noteId: string): { noteId: string; title: string; content: string; folderPath: string } | null;
  getTags(noteId: string): string[];
  listCategorySummariesWithMembers(): Array<{ category: string; content: string; memberIds: string[] }>;
  getProfileSummary(): string | null;
  recordInjectionPresence(noteIds: readonly string[]): void;
  warn(message: string): void;
}

function clipChars(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  if (maxChars <= 1) return chars.slice(0, Math.max(0, maxChars)).join('');
  return `${chars.slice(0, maxChars - 1).join('')}…`;
}

function renderCompactProfileForKernel(
  profile: LearnerProfile,
  maxChars: number,
  scopedRules: readonly MemoryHardRule[],
): { markdown: string; weakPointKeys: string[]; projectedPreferences?: LearnerPreferences } {
  const reconciled = filterProfileForActiveHardRules(profile, scopedRules);
  if (isProfileContentEmpty(reconciled)) return { markdown: '', weakPointKeys: [] };
  const topWeakPoints = reconciled.weak_points.slice(0, MAX_KERNEL_WEAK_POINTS);
  const projected: LearnerProfile = { ...reconciled, weak_points: topWeakPoints };
  let rendered = renderLearnerProfile(projected).trim();
  if (rendered === '') return { markdown: '', weakPointKeys: [] };
  if (ruleCharLength(rendered) > maxChars) {
    rendered = clipChars(rendered, maxChars);
  }
  const weakPointKeys = topWeakPoints.map(wp => `${wp.subject}:${wp.knowledge_point}`);
  const heading = isChineseDominantText(rendered) ? '## 学习者长期画像' : '## Long-Term Learner Profile';
  return {
    markdown: `${heading}\n${rendered}`,
    weakPointKeys,
    projectedPreferences: {
      explanation_style: reconciled.preferences.explanation_style ?? null,
      language: reconciled.preferences.language ?? null,
      pace: reconciled.preferences.pace ?? null,
      others: [...reconciled.preferences.others],
    },
  };
}

/**
 * Deterministic bridge for user-authored preference/important notes in VFS memory
 * (e.g. written directly in MemoryView before migrating to HardRules), ensuring
 * Turn-1 availability without waiting for throttled LLM `__cat_*__` refreshes.
 * Legacy notes contradicted by active L1 HardRules are filtered out.
 */
function buildLegacyPreferenceBridge(
  host: LocalMemoryProviderHost,
  scopedRules: readonly MemoryHardRule[],
  hasLearnerProfile: boolean,
  budgetChars: number,
): { section: string; noteIds: string[] } {
  if (budgetChars < 80) return { section: '', noteIds: [] };
  let rootId: string | null = null;
  try { rootId = host.getRootFolderId(); } catch { return { section: '', noteIds: [] }; }
  if (rootId === null) return { section: '', noteIds: [] };

  const hasHardRules = scopedRules.length > 0;
  const selectedEntries: Array<{ id: string; title: string; rawBody: string }> = [];
  const maxBridgeChars = Math.min(budgetChars, MAX_LEGACY_BRIDGE_CHARS);
  const headingReserve = Math.max(
    ruleCharLength(LEGACY_BRIDGE_HEADING_ZH),
    ruleCharLength(LEGACY_BRIDGE_HEADING_NEUTRAL),
  ) + 1;
  let usedChars = headingReserve;

  try {
    const items = host.list(null);
    const activeItems = items
      .filter(item => !item.isArchived && !item.isStale)
      .filter(item => !item.folderPath.includes('__system__'))
      .filter(item => !item.title.trimStart().startsWith('__'))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, MAX_LEGACY_BRIDGE_SCAN_NOTES);

    const scored: Array<{ item: MemoryListItem; rawBody: string; priority: number }> = [];
    for (const item of activeItems) {
      const tags = safeGetTags(host, item.id);
      if (tags.includes('_system') || tags.includes('daily_log')) continue;

      const full = safeRead(host, item.id);
      const rawBody = (full?.content ?? '').replace(/\s+/g, ' ').trim();
      if (rawBody === '') continue;

      // Filter out legacy preference notes superseded/contradicted by active L1 HardRules.
      const combinedText = `${item.title}\n${rawBody}`;
      if (scopedRules.some(rule => detectTextContradiction(rule.instruction, combinedText) !== null)) {
        continue;
      }

      const folder = item.folderPath;
      const folderSegments = folder.toLowerCase().split('/').map(s => s.trim()).filter(Boolean);
      const isPrefFolder = folderSegments.some(
        seg => seg === '偏好' || seg === 'preferences' || seg === 'preference' || seg === 'prefs' || seg === 'style' || seg === 'habits',
      );
      const isImportant = item.isImportant || tags.includes('_important');
      const matchesPreferenceOrInstruction = LEGACY_PREFERENCE_BRIDGE_RE.test(`${folder}\n${combinedText}`);
      const isUserSubfolder = folder.trim() !== '';
      const isExplicitUserMemory =
        isUserSubfolder
        || item.memoryType === 'fact'
        || item.memoryType === 'study'
        || item.memoryPurpose === 'memorized'
        || item.memoryPurpose === 'internalized'
        || tags.some(t =>
          t === 'memorized'
          || t === '_purpose:memorized'
          || t === 'fact'
          || t === 'study'
          || t === '_type:study',
        );

      const eligible =
        isPrefFolder
        || isImportant
        || matchesPreferenceOrInstruction
        || isExplicitUserMemory
        || (!hasHardRules && !hasLearnerProfile);
      if (!eligible) continue;

      const priority =
        (isPrefFolder || isImportant ? 2 : 0)
        + (matchesPreferenceOrInstruction ? 2 : 0)
        + (isExplicitUserMemory ? 1 : 0);
      scored.push({ item, rawBody, priority });
    }

    scored.sort((a, b) => (
      b.priority - a.priority || b.item.updatedAt.localeCompare(a.item.updatedAt)
    ));

    for (const { item, rawBody } of scored) {
      if (selectedEntries.length >= MAX_LEGACY_BRIDGE_NOTES) break;
      const clipped = clipChars(rawBody, 180);
      const approxLen = ruleCharLength(item.title) + ruleCharLength(clipped) + 8;
      if (usedChars + approxLen > maxBridgeChars) continue;
      selectedEntries.push({ id: item.id, title: item.title, rawBody: clipped });
      usedChars += approxLen;
    }
  } catch (error) {
    host.warn(`[MemoryProvider] legacy preference bridge failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (selectedEntries.length > 0) {
    const chinese = isChineseDominantText(selectedEntries.map(e => `${e.title} ${e.rawBody}`).join(' '));
    const heading = chinese ? LEGACY_BRIDGE_HEADING_ZH : LEGACY_BRIDGE_HEADING_NEUTRAL;
    const lines = selectedEntries.map(e => (
      chinese
        ? `- ${e.title ? `【${e.title}】` : ''}${e.rawBody}`
        : `- ${e.title ? `[${e.title}] ` : ''}${e.rawBody}`
    ));
    return {
      section: `${heading}\n${lines.join('\n')}`,
      noteIds: selectedEntries.map(e => e.id),
    };
  }

  // Final fallback when no direct notes matched and both HardRules + LearnerProfile are empty:
  // read legacy `__cat_*__` or `__user_profile__` once so legacy databases never regress.
  if (!hasHardRules && !hasLearnerProfile) {
    try {
      const summaries = host.listCategorySummariesWithMembers();
      if (summaries.length > 0) {
        const chunks: string[] = [];
        const memberIds: string[] = [];
        let total = 0;
        for (const s of summaries) {
          const text = `### ${s.category}\n${s.content}`;
          const len = ruleCharLength(text) + 2;
          if (total + len > budgetChars && chunks.length > 0) break;
          chunks.push(text);
          memberIds.push(...s.memberIds);
          total += len;
        }
        if (chunks.length > 0) {
          const joined = chunks.join('\n\n');
          const bgHeading = isChineseDominantText(joined) ? '## 用户已知背景' : '## Known User Background';
          return {
            section: `${bgHeading}\n${clipChars(joined, budgetChars)}`,
            noteIds: [...new Set(memberIds)],
          };
        }
      }
      const legacySummary = host.getProfileSummary();
      if (legacySummary && legacySummary.trim() !== '') {
        const trimmedSummary = legacySummary.trim();
        const bgHeading = isChineseDominantText(trimmedSummary) ? '## 用户已知背景' : '## Known User Background';
        return {
          section: `${bgHeading}\n${clipChars(trimmedSummary, budgetChars)}`,
          noteIds: [],
        };
      }
    } catch (error) {
      host.warn(`[MemoryProvider] legacy category fallback failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { section: '', noteIds: [] };
}

function safeGetTags(host: LocalMemoryProviderHost, noteId: string): string[] {
  try { return host.getTags(noteId); } catch { return []; }
}

function safeRead(host: LocalMemoryProviderHost, noteId: string): { noteId: string; title: string; content: string; folderPath: string } | null {
  try { return host.read(noteId); } catch { return null; }
}

export class LocalMemoryProvider implements MemoryProvider {
  readonly id = LOCAL_MEMORY_PROVIDER_ID;
  private readonly host: LocalMemoryProviderHost;

  constructor(host: LocalMemoryProviderHost) {
    this.host = host;
  }

  buildSessionSnapshot(req: SessionSnapshotRequest): MemorySessionSnapshot {
    const now = chronoRfc3339();
    const rulesMaxChars = this.host.getHardRulesMaxChars();
    const profileMaxChars = this.host.getLearnerProfileKernelMaxChars();
    const maxChars = rulesMaxChars + profileMaxChars;

    if (req.memoryEnabled === false) {
      return emptySnapshot(this.id, maxChars, now);
    }
    try {
      if (this.host.isPrivacyMode()) return emptySnapshot(this.id, maxChars, now);
    } catch (error) {
      this.host.warn(`[MemoryProvider] privacy mode check failed (session=${req.sessionId}): ${error instanceof Error ? error.message : String(error)}`);
      return emptySnapshot(this.id, maxChars, now);
    }

    const hardRulesDoc = this.host.loadHardRules();
    const scopedRules = filterHardRulesForScope(hardRulesDoc.rules, { subject: req.subject, mode: req.mode });
    const renderedRules = renderHardRules(scopedRules);
    const rulesSection = renderedRules !== '' ? clipChars(renderedRules, rulesMaxChars) : '';

    const profile = this.host.loadProfile();
    const hasProfile = profile !== null && !isProfileContentEmpty(profile);
    const profileProjection = hasProfile
      ? renderCompactProfileForKernel(profile, profileMaxChars, scopedRules)
      : { markdown: '', weakPointKeys: [] };

    const hasSecondaryLayer = profileProjection.markdown !== '';
    const sampleForPrecedence = [rulesSection, profileProjection.markdown].filter(Boolean).join('\n');
    const precedenceLine = rulesSection !== ''
      ? (isChineseDominantText(sampleForPrecedence)
        ? '> 优先级：完整回答用户所有子问题最优先；下列 L1 互动硬规则严格覆盖与之矛盾的 L2 画像或历史偏好。'
        : '> Precedence: answer every part of the user\'s request completely first; L1 Hard Interaction Rules below strictly override contradicting L2 profile or legacy preferences.')
      : '';
    const precedenceReserve = precedenceLine !== '' ? ruleCharLength(precedenceLine) + 2 : 0;

    const remainingBudget = Math.max(
      0,
      maxChars - ruleCharLength(rulesSection) - ruleCharLength(profileProjection.markdown) - precedenceReserve - 4,
    );
    const bridge = buildLegacyPreferenceBridge(this.host, scopedRules, hasProfile, remainingBudget);

    const showPrecedence = rulesSection !== '' && (hasSecondaryLayer || bridge.section !== '');
    const sections = [
      showPrecedence ? precedenceLine : '',
      rulesSection,
      profileProjection.markdown,
      bridge.section,
    ].filter(s => s.trim() !== '');
    const renderedKernel = sections.join('\n\n');

    if (bridge.noteIds.length > 0) {
      setTimeout(() => {
        try { this.host.recordInjectionPresence(bridge.noteIds); }
        catch { /* fire-and-forget */ }
      }, 0);
    }

    return {
      providerId: this.id,
      renderedKernel,
      rulesVersion: hardRulesDoc.version,
      profileVersion: profile?.version ?? 0,
      includedRuleIds: scopedRules.map(r => r.id),
      includedRules: scopedRules.map(r => ({ id: r.id, instruction: r.instruction, scope: r.scope })),
      includedWeakPointKeys: profileProjection.weakPointKeys,
      includedPreferences: profileProjection.projectedPreferences,
      includedLegacyNoteIds: bridge.noteIds,
      charCount: ruleCharLength(renderedKernel),
      maxChars,
      snapshotAt: now,
      generation: 1,
    };
  }

  buildSessionDelta(req: SessionSnapshotRequest, frozen: MemorySessionSnapshot): string | null {
    if (req.memoryEnabled === false) return null;
    try { if (this.host.isPrivacyMode()) return null; } catch { return null; }

    const deltaParts: string[] = [];

    const hardRulesDoc = this.host.loadHardRules();
    if (hardRulesDoc.version > frozen.rulesVersion) {
      const scoped = filterHardRulesForScope(hardRulesDoc.rules, { subject: req.subject, mode: req.mode });
      const rulesDelta = buildHardRulesDelta(scoped, frozen.includedRuleIds, frozen.snapshotAt, frozen.includedRules);
      if (rulesDelta !== null) deltaParts.push(rulesDelta);
    }

    const profile = this.host.loadProfile();
    if (profile !== null && profile.version > frozen.profileVersion) {
      const currentKeys = new Set(profile.weak_points.slice(0, MAX_KERNEL_WEAK_POINTS).map(wp => `${wp.subject}:${wp.knowledge_point}`));
      const frozenKeys = new Set(frozen.includedWeakPointKeys);
      const addedWeak = [...currentKeys].filter(k => !frozenKeys.has(k));
      if (addedWeak.length > 0) {
        const joinedWeak = addedWeak.join(', ');
        deltaParts.push(isChineseDominantText(joinedWeak)
          ? `+ 会话中新识别薄弱点：${addedWeak.join('、')}`
          : `+ New weak points identified in session: ${joinedWeak}`);
      }
      if (profile.recent_status && profile.updated_at > frozen.snapshotAt) {
        const clippedStatus = clipChars(profile.recent_status, 140);
        deltaParts.push(isChineseDominantText(clippedStatus)
          ? `* 近期状态更新：${clippedStatus}`
          : `* Recent status updated: ${clippedStatus}`);
      }
      if (frozen.includedPreferences) {
        const prev = frozen.includedPreferences;
        const curr = profile.preferences;
        for (const field of ['explanation_style', 'language', 'pace'] as const) {
          const before = prev[field] ?? null;
          const after = curr[field] ?? null;
          if (before !== after) {
            const sample = `${before ?? ''} ${after ?? ''}`;
            const chinese = isChineseDominantText(sample);
            if (after === null && before !== null) {
              deltaParts.push(chinese
                ? `- 【已作废偏好】画像 ${field}「${clipChars(before, 60)}」已被新规则覆盖并移除。`
                : `- [SUPERSEDED PREFERENCE] Profile ${field} "${clipChars(before, 60)}" was cleared by a newer rule.`);
            } else if (after !== null) {
              deltaParts.push(chinese
                ? `* 画像偏好 ${field} 更新为：${clipChars(after, 80)}`
                : `* Profile preference ${field} updated to: ${clipChars(after, 80)}`);
            }
          }
        }
        const currOthers = new Set(curr.others.map(s => s.trim()));
        for (const oldPref of prev.others) {
          if (!currOthers.has(oldPref.trim())) {
            deltaParts.push(isChineseDominantText(oldPref)
              ? `- 【已作废偏好】画像偏好「${clipChars(oldPref, 60)}」已被移除。`
              : `- [SUPERSEDED PREFERENCE] Profile preference "${clipChars(oldPref, 60)}" was removed.`);
          }
        }
      }
    }

    if (deltaParts.length === 0) return null;
    return clipChars(deltaParts.join('\n'), 500);
  }

  ingestSignal(signal: LearningSignal): void {
    if (signal.kind === 'chat_correction') {
      const text = signal.ruleOrFeedback.trim();
      if (text === '') return;
      try {
        this.host.upsertHardRule(
          {
            instruction: text,
            scope: signal.subject ? `subject:${signal.subject}` : 'global',
            origin: 'chat_correction',
            pinned: false,
          },
          {
            source: 'auto_extract',
            sessionId: signal.sessionId,
            reason: '对话显式纠偏沉淀至 L1 硬规则',
            limitPolicy: 'enforce',
          },
        );
      } catch (error) {
        this.host.warn(`[MemoryProvider] ingestSignal(chat_correction) failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

const EN_ESSAY_DIMENSION_MAP: Record<string, string> = {
  '创意与表达': 'Creativity & Expression',
  '内容完整': 'Content Completeness',
  '语言规范': 'Language Conventions',
  '内容': 'Content',
  '结构': 'Structure',
  '语言': 'Language',
  '中心立意': 'Central Thesis',
  '论证充实': 'Evidence & Reasoning',
  '结构严谨': 'Structural Coherence',
  '语言文采': 'Language & Style',
  '内容切题': 'Task Relevance',
};

function localizeEssayDimensionName(name: string, useEnglish: boolean): string {
  const trimmed = name.trim();
  if (!useEnglish) return trimmed;
  return EN_ESSAY_DIMENSION_MAP[trimmed] ?? trimmed;
}

    if (signal.kind === 'essay_graded') {
      const today = new Date().toISOString().slice(0, 10);
      const useEnglish = (signal.locale ?? '').trim().toLowerCase().startsWith('en');
      const weakDims = signal.rubricDimensions.filter(d => d.maxScore > 0 && d.score / d.maxScore < 0.65);
      if (weakDims.length === 0) return;
      const update = emptyProfileUpdate();
      for (const dim of weakDims) {
        const pct = Math.round((dim.score / dim.maxScore) * 100);
        const detail = dim.recurringIssue?.trim()
          || (useEnglish
            ? `Score ${dim.score}/${dim.maxScore} (${pct}%)`
            : `得分 ${dim.score}/${dim.maxScore} (${pct}%)`);
        update.weak_points_add.push({
          subject: signal.examType.trim() || (useEnglish ? 'Essay' : '作文'),
          knowledge_point: localizeEssayDimensionName(dim.name, useEnglish),
          error_pattern: `[essay] ${clipChars(detail, 120)}`,
          evidence_count: 1,
          last_seen: today,
          source: 'essay',
        });
      }
      try {
        this.host.applyProfileUpdate(update, {
          source: 'auto_extract',
          sessionId: null,
          reason: useEnglish
            ? `Essay rubric weak-dimension ingestion (${signal.examType})`
            : `作文批改低分维度沉淀 (${signal.examType})`,
          limitPolicy: 'enforce',
        });
      } catch (error) {
        this.host.warn(`[MemoryProvider] ingestSignal(essay_graded) failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    if (signal.kind === 'study_artifact_friction') {
      const concept = signal.concept.trim();
      const detail = signal.detail.trim();
      if (!concept || !detail) return;
      const today = new Date().toISOString().slice(0, 10);
      const update = emptyProfileUpdate();
      update.weak_points_add.push({
        subject: signal.source.toUpperCase(),
        knowledge_point: concept,
        error_pattern: `[${signal.source}] ${clipChars(detail, 120)}`,
        evidence_count: 1,
        last_seen: today,
        source: signal.source,
      });
      try {
        this.host.applyProfileUpdate(update, {
          source: 'auto_extract',
          sessionId: null,
          reason: `学习资料高频卡点沉淀 (${signal.source})`,
          limitPolicy: 'enforce',
        });
      } catch (error) {
        this.host.warn(`[MemoryProvider] ingestSignal(study_artifact_friction) failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  inspect(): MemoryInspectionView {
    const privacyMode = safeIsPrivacyMode(this.host);
    const hardRules = this.host.loadHardRules();
    const learnerProfile = this.host.loadProfile() ?? emptyProfile();
    const profileHistory = this.host.loadProfileHistory();
    const rulesMaxChars = this.host.getHardRulesMaxChars();
    const profileMaxChars = this.host.getLearnerProfileKernelMaxChars();
    const preview = this.buildSessionSnapshot({ sessionId: '__inspect__', memoryEnabled: true });

    return {
      providerId: this.id,
      privacyMode,
      hardRules,
      learnerProfile,
      profileHistory,
      renderedKernelPreview: preview.renderedKernel,
      budgets: {
        rulesChars: renderedHardRulesCharCount(hardRules),
        rulesMaxChars,
        profileChars: renderedCharCount(learnerProfile),
        profileMaxChars,
      },
    };
  }

  mutateFromUser(mutation: UserMemoryMutation): MemoryInspectionView {
    switch (mutation.kind) {
      case 'upsert_rule':
        this.host.upsertHardRule(mutation.input, {
          source: 'handler',
          sessionId: null,
          reason: '用户在 MemoryView 编辑互动硬规则',
          limitPolicy: 'reject',
        });
        break;
      case 'remove_rule':
        this.host.removeHardRule(mutation.idOrInstruction, {
          source: 'handler',
          sessionId: null,
          reason: '用户在 MemoryView 删除互动硬规则',
        });
        break;
      case 'update_profile':
        this.host.applyProfileUpdate(mutation.update, {
          source: 'handler',
          sessionId: null,
          reason: '用户在 MemoryView 编辑学习者画像',
          limitPolicy: 'reject',
        });
        break;
      case 'rollback_profile':
        this.host.rollbackProfileToVersion(mutation.targetVersion, {
          source: 'handler',
          sessionId: null,
          reason: `用户在 MemoryView 回滚学习者画像至 v${mutation.targetVersion}`,
        });
        break;
      case 'set_budgets':
        if (mutation.rulesMaxChars !== undefined) {
          this.host.setConfigValue(HARD_RULES_MAX_CHARS_CONFIG_KEY, String(clampHardRulesMaxChars(mutation.rulesMaxChars)));
        }
        if (mutation.profileMaxChars !== undefined) {
          this.host.setConfigValue(
            LEARNER_PROFILE_KERNEL_MAX_CHARS_CONFIG_KEY,
            String(clampLearnerProfileKernelMaxChars(mutation.profileMaxChars)),
          );
        }
        break;
    }
    return this.inspect();
  }

  reflect(): DialecticReflectionReport {
    const view = this.inspect();
    return runDialecticReflection({
      hardRules: view.hardRules,
      learnerProfile: view.learnerProfile,
      rulesChars: view.budgets.rulesChars,
      rulesMaxChars: view.budgets.rulesMaxChars,
      profileChars: view.budgets.profileChars,
      profileMaxChars: view.budgets.profileMaxChars,
    });
  }
}

function emptySnapshot(providerId: string, maxChars: number, now: string): MemorySessionSnapshot {
  return {
    providerId,
    renderedKernel: '',
    rulesVersion: 0,
    profileVersion: 0,
    includedRuleIds: [],
    includedWeakPointKeys: [],
    includedLegacyNoteIds: [],
    charCount: 0,
    maxChars,
    snapshotAt: now,
    generation: 1,
  };
}

function safeIsPrivacyMode(host: LocalMemoryProviderHost): boolean {
  try { return host.isPrivacyMode(); } catch { return false; }
}
