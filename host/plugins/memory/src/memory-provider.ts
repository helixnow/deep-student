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
  filterHardRulesForScope, HARD_RULES_MAX_CHARS_CONFIG_KEY,
  LEARNER_PROFILE_KERNEL_MAX_CHARS_CONFIG_KEY, renderHardRules, renderedHardRulesCharCount,
  ruleCharLength, type HardRuleUpsertInput, type HardRulesDocument, type MemoryHardRule,
} from './hard-rules.ts';
import {
  emptyProfile, emptyProfileUpdate, isProfileContentEmpty, renderLearnerProfile, renderedCharCount,
  type LearnerProfile, type LearnerProfileUpdate,
} from './learner-profile.ts';
import type { ProfileUpdateOptions } from './profile-store.ts';
import { runDialecticReflection, type DialecticReflectionReport } from './dialectic-reflection.ts';

export type { DialecticProposal, DialecticProposalKind, DialecticReflectionReport } from './dialectic-reflection.ts';

export const LOCAL_MEMORY_PROVIDER_ID = 'dstu.memory.local';
const MAX_KERNEL_WEAK_POINTS = 12;
const MAX_LEGACY_BRIDGE_NOTES = 6;
const MAX_LEGACY_BRIDGE_CHARS = 900;

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
  includedWeakPointKeys: string[];
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

function renderCompactProfileForKernel(profile: LearnerProfile, maxChars: number): { markdown: string; weakPointKeys: string[] } {
  if (isProfileContentEmpty(profile)) return { markdown: '', weakPointKeys: [] };
  const topWeakPoints = profile.weak_points.slice(0, MAX_KERNEL_WEAK_POINTS);
  const projected: LearnerProfile = { ...profile, weak_points: topWeakPoints };
  let rendered = renderLearnerProfile(projected).trim();
  if (rendered === '') return { markdown: '', weakPointKeys: [] };
  if (ruleCharLength(rendered) > maxChars) {
    rendered = clipChars(rendered, maxChars);
  }
  const weakPointKeys = topWeakPoints.map(wp => `${wp.subject}:${wp.knowledge_point}`);
  return { markdown: `## 学习者长期画像\n${rendered}`, weakPointKeys };
}

/**
 * Deterministic bridge for user-authored preference/important notes in VFS memory
 * (e.g. written directly in MemoryView before migrating to HardRules), ensuring
 * Turn-1 availability without waiting for throttled LLM `__cat_*__` refreshes.
 */
function buildLegacyPreferenceBridge(
  host: LocalMemoryProviderHost,
  hasHardRules: boolean,
  hasLearnerProfile: boolean,
  budgetChars: number,
): { section: string; noteIds: string[] } {
  if (budgetChars < 80) return { section: '', noteIds: [] };
  let rootId: string | null = null;
  try { rootId = host.getRootFolderId(); } catch { return { section: '', noteIds: [] }; }
  if (rootId === null) return { section: '', noteIds: [] };

  const lines: string[] = [];
  const noteIds: string[] = [];
  let usedChars = 0;

  try {
    const items = host.list(null);
    // Prioritize notes inside 偏好/*, or tagged _important, or explicit user fact/study notes when kernel is still empty.
    const candidates = items
      .filter(item => !item.folderPath.includes('__system__'))
      .filter(item => {
        if (item.isArchived || item.isStale) return false;
        const folder = item.folderPath;
        const isPrefFolder = folder === '偏好' || folder.startsWith('偏好/') || folder.includes('/偏好');
        const tags = safeGetTags(host, item.id);
        if (tags.includes('_system')) return false;
        if (isPrefFolder || item.isImportant || tags.includes('_important')) return true;
        // When the learner hasn't populated HardRules or LearnerProfile yet, surface up to a few recent user notes
        // so freshly created memories in MemoryView are deterministically known from Turn 1.
        return !hasHardRules && !hasLearnerProfile;
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, MAX_LEGACY_BRIDGE_NOTES);

    for (const item of candidates) {
      const full = safeRead(host, item.id);
      const rawBody = (full?.content ?? '').replace(/\s+/g, ' ').trim();
      if (rawBody === '') continue;
      const line = `- ${item.title ? `【${item.title}】` : ''}${clipChars(rawBody, 180)}`;
      const len = ruleCharLength(line) + 1;
      if (usedChars + len > Math.min(budgetChars, MAX_LEGACY_BRIDGE_CHARS)) break;
      lines.push(line);
      noteIds.push(item.id);
      usedChars += len;
    }
  } catch (error) {
    host.warn(`[MemoryProvider] legacy preference bridge failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (lines.length > 0) {
    return {
      section: `## 用户已记录的核心记忆与偏好\n${lines.join('\n')}`,
      noteIds,
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
          return {
            section: `## 用户已知背景\n${clipChars(chunks.join('\n\n'), budgetChars)}`,
            noteIds: [...new Set(memberIds)],
          };
        }
      }
      const legacySummary = host.getProfileSummary();
      if (legacySummary && legacySummary.trim() !== '') {
        return {
          section: `## 用户已知背景\n${clipChars(legacySummary.trim(), budgetChars)}`,
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
      ? renderCompactProfileForKernel(profile, profileMaxChars)
      : { markdown: '', weakPointKeys: [] };

    const remainingBudget = Math.max(0, maxChars - ruleCharLength(rulesSection) - ruleCharLength(profileProjection.markdown) - 4);
    const bridge = buildLegacyPreferenceBridge(this.host, scopedRules.length > 0, hasProfile, remainingBudget);

    const sections = [rulesSection, profileProjection.markdown, bridge.section].filter(s => s.trim() !== '');
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
      includedWeakPointKeys: profileProjection.weakPointKeys,
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
      const rulesDelta = buildHardRulesDelta(scoped, frozen.includedRuleIds, frozen.snapshotAt);
      if (rulesDelta !== null) deltaParts.push(rulesDelta);
    }

    const profile = this.host.loadProfile();
    if (profile !== null && profile.version > frozen.profileVersion && !isProfileContentEmpty(profile)) {
      const currentKeys = new Set(profile.weak_points.slice(0, MAX_KERNEL_WEAK_POINTS).map(wp => `${wp.subject}:${wp.knowledge_point}`));
      const frozenKeys = new Set(frozen.includedWeakPointKeys);
      const addedWeak = [...currentKeys].filter(k => !frozenKeys.has(k));
      if (addedWeak.length > 0) {
        deltaParts.push(`+ 会话中新识别薄弱点：${addedWeak.join('、')}`);
      }
      if (profile.recent_status && profile.updated_at > frozen.snapshotAt) {
        deltaParts.push(`* 近期状态更新：${clipChars(profile.recent_status, 140)}`);
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

    if (signal.kind === 'essay_graded') {
      const today = new Date().toISOString().slice(0, 10);
      const weakDims = signal.rubricDimensions.filter(d => d.maxScore > 0 && d.score / d.maxScore < 0.65);
      if (weakDims.length === 0) return;
      const update = emptyProfileUpdate();
      for (const dim of weakDims) {
        const pct = Math.round((dim.score / dim.maxScore) * 100);
        const detail = dim.recurringIssue?.trim() || `得分 ${dim.score}/${dim.maxScore} (${pct}%)`;
        update.weak_points_add.push({
          subject: signal.examType.trim() || '作文',
          knowledge_point: dim.name.trim(),
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
          reason: `作文批改低分维度沉淀 (${signal.examType})`,
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
