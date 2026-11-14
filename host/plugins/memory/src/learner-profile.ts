/**
 * Learner profile pure layer — TS mirror of
 * `dstu-memory/src/memory/learner_profile.rs` (merge/render/limits/JSON/sync).
 *
 * Persistence (system notes, CAS retries, history) is not part of this module.
 */

export const LEARNER_PROFILE_NOTE_TITLE = '__learner_profile__';
export const LEARNER_PROFILE_HISTORY_NOTE_TITLE = '__learner_profile_history__';
export const LEARNER_PROFILE_MAX_CHARS = 4000;
export const MAX_WEAK_POINTS = 20;
export const MAX_GOALS = 10;
export const MAX_OTHER_PREFERENCES = 10;
export const MAX_RECENT_STATUS_CHARS = 500;
export const PROFILE_HISTORY_KEEP = 5;
const PROMOTION_FINGERPRINT_JSON_KEY = '_promotion_fingerprint';

export interface WeakPoint {
  subject: string;
  knowledge_point: string;
  error_pattern: string;
  evidence_count: number;
  last_seen?: string | null;
  source?: string | null;
}

export interface LearnerPreferences {
  explanation_style?: string | null;
  language?: string | null;
  pace?: string | null;
  others: string[];
}

export interface LearningGoal {
  goal: string;
  deadline?: string | null;
}

export interface LearnerProfile {
  version: number;
  updated_at: string;
  weak_points: WeakPoint[];
  preferences: LearnerPreferences;
  goals: LearningGoal[];
  recent_status?: string | null;
  last_promotion_fingerprint?: string | null;
}

export interface WeakPointKey {
  subject: string;
  knowledge_point: string;
}

export interface PreferencesPatch {
  explanation_style?: string | null;
  language?: string | null;
  pace?: string | null;
  others_add: string[];
  others_remove: string[];
}

export interface LearnerProfileUpdate {
  weak_points_add: WeakPoint[];
  weak_points_remove: WeakPointKey[];
  preferences?: PreferencesPatch | null;
  goals_add: LearningGoal[];
  goals_remove: string[];
  recent_status?: string | null;
}

export function emptyProfile(): LearnerProfile {
  return {
    version: 0, updated_at: '', weak_points: [],
    preferences: { explanation_style: null, language: null, pace: null, others: [] },
    goals: [], recent_status: null, last_promotion_fingerprint: null,
  };
}

export function emptyProfileUpdate(): LearnerProfileUpdate {
  return {
    weak_points_add: [], weak_points_remove: [], preferences: null, goals_add: [],
    goals_remove: [], recent_status: null,
  };
}

export function emptyPreferencesPatch(): PreferencesPatch {
  return {
    explanation_style: null, language: null, pace: null, others_add: [], others_remove: [],
  };
}

export function isProfileUpdateEmpty(update: LearnerProfileUpdate): boolean {
  return update.weak_points_add.length === 0 && update.weak_points_remove.length === 0
    && (update.preferences === null || update.preferences === undefined)
    && update.goals_add.length === 0 && update.goals_remove.length === 0
    && (update.recent_status === null || update.recent_status === undefined);
}

/** Rust `eq_ignore_ascii_case` (ASCII only; Unicode case folding is not applied). */
export function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, char => char.toLowerCase());
}

export function weakPointKeyEq(aSubject: string, aPoint: string, bSubject: string,
  bPoint: string): boolean {
  return asciiLower(aSubject.trim()) === asciiLower(bSubject.trim())
    && asciiLower(aPoint.trim()) === asciiLower(bPoint.trim());
}

function saturatingAddU32(left: number, right: number): number {
  return Math.min(0xffffffff, left + right);
}

/** Rust `LearnerProfile::merge_update` (merge semantics, mutates and reports change). */
export function mergeLearnerProfileUpdate(profile: LearnerProfile,
  update: LearnerProfileUpdate): boolean {
  let changed = false;

  for (const incoming of update.weak_points_add) {
    if (incoming.subject.trim() === '' || incoming.knowledge_point.trim() === '') continue;
    const existing = profile.weak_points.find(wp =>
      weakPointKeyEq(wp.subject, wp.knowledge_point, incoming.subject, incoming.knowledge_point));
    if (existing !== undefined) {
      existing.evidence_count = saturatingAddU32(existing.evidence_count,
        Math.max(1, incoming.evidence_count));
      if (incoming.error_pattern.trim() !== '') existing.error_pattern = incoming.error_pattern;
      if (incoming.last_seen !== null && incoming.last_seen !== undefined) {
        existing.last_seen = incoming.last_seen;
      }
      if (incoming.source !== null && incoming.source !== undefined) {
        existing.source = incoming.source;
      }
    } else {
      const copy: WeakPoint = {
        subject: incoming.subject,
        knowledge_point: incoming.knowledge_point,
        error_pattern: incoming.error_pattern,
        evidence_count: Math.max(1, incoming.evidence_count),
        last_seen: incoming.last_seen ?? null,
        ...(incoming.source === null || incoming.source === undefined
          ? {} : { source: incoming.source }),
      };
      profile.weak_points.push(copy);
    }
    changed = true;
  }

  for (const key of update.weak_points_remove) {
    const before = profile.weak_points.length;
    profile.weak_points = profile.weak_points.filter(wp =>
      !weakPointKeyEq(wp.subject, wp.knowledge_point, key.subject, key.knowledge_point));
    if (profile.weak_points.length !== before) changed = true;
  }

  const patch = update.preferences;
  if (patch !== null && patch !== undefined) {
    for (const field of ['explanation_style', 'language', 'pace'] as const) {
      const value = patch[field];
      if (value !== null && value !== undefined && value.trim() !== '') {
        profile.preferences[field] = value;
        changed = true;
      }
    }
    for (const item of patch.others_add) {
      const trimmed = item.trim();
      if (trimmed === '') continue;
      if (!profile.preferences.others.some(other => other.trim() === trimmed)) {
        profile.preferences.others.push(trimmed);
        changed = true;
      }
    }
    for (const item of patch.others_remove) {
      const before = profile.preferences.others.length;
      profile.preferences.others = profile.preferences.others
        .filter(other => other.trim() !== item.trim());
      if (profile.preferences.others.length !== before) changed = true;
    }
  }

  for (const goal of update.goals_add) {
    const trimmed = goal.goal.trim();
    if (trimmed === '') continue;
    const existing = profile.goals.find(item => item.goal.trim() === trimmed);
    if (existing !== undefined) {
      if (goal.deadline !== null && goal.deadline !== undefined
        && existing.deadline !== goal.deadline) {
        existing.deadline = goal.deadline;
        changed = true;
      }
    } else {
      profile.goals.push({
        goal: goal.goal,
        deadline: goal.deadline ?? null,
      });
      changed = true;
    }
  }
  for (const goalText of update.goals_remove) {
    const before = profile.goals.length;
    profile.goals = profile.goals.filter(goal => goal.goal.trim() !== goalText.trim());
    if (profile.goals.length !== before) changed = true;
  }

  if (update.recent_status !== null && update.recent_status !== undefined) {
    const trimmed = update.recent_status.trim();
    if (trimmed !== '' && profile.recent_status !== trimmed) {
      profile.recent_status = trimmed;
      changed = true;
    }
  }

  return changed;
}

/** Rust `LearnerProfile::render_markdown`. */
export function renderLearnerProfile(profile: LearnerProfile): string {
  const lines: string[] = [];
  lines.push(`# 学习者画像（v${profile.version}，更新于 ${profile.updated_at === '' ? '未知' : profile.updated_at}）`);

  if (profile.weak_points.length > 0) {
    lines.push('## 薄弱知识点');
    for (const wp of profile.weak_points) {
      const lastSeen = wp.last_seen === null || wp.last_seen === undefined
        ? '' : `，最近 ${wp.last_seen}`;
      lines.push(`- [${wp.subject}/${wp.knowledge_point}] ${wp.error_pattern}（证据×${wp.evidence_count}${lastSeen}）`);
    }
  }

  const prefs = profile.preferences;
  const hasPrefs = prefs.explanation_style !== null && prefs.explanation_style !== undefined
    || prefs.language !== null && prefs.language !== undefined
    || prefs.pace !== null && prefs.pace !== undefined
    || prefs.others.length > 0;
  if (hasPrefs) {
    lines.push('## 学习偏好');
    if (prefs.explanation_style !== null && prefs.explanation_style !== undefined) {
      lines.push(`- 讲解风格：${prefs.explanation_style}`);
    }
    if (prefs.language !== null && prefs.language !== undefined) {
      lines.push(`- 语言：${prefs.language}`);
    }
    if (prefs.pace !== null && prefs.pace !== undefined) {
      lines.push(`- 节奏：${prefs.pace}`);
    }
    for (const other of prefs.others) lines.push(`- ${other}`);
  }

  if (profile.goals.length > 0) {
    lines.push('## 学习目标');
    for (const goal of profile.goals) {
      lines.push(goal.deadline === null || goal.deadline === undefined
        ? `- ${goal.goal}` : `- ${goal.goal}（期限 ${goal.deadline}）`);
    }
  }

  if (profile.recent_status !== null && profile.recent_status !== undefined
    && profile.recent_status.trim() !== '') {
    lines.push('## 近期状态');
    lines.push(profile.recent_status.trim());
  }

  return lines.join('\n');
}

export function renderedCharCount(profile: LearnerProfile): number {
  return Array.from(renderLearnerProfile(profile)).length;
}

/** Rust `LearnerProfile::is_content_empty`. */
export function isProfileContentEmpty(profile: LearnerProfile): boolean {
  const prefs = profile.preferences;
  return profile.weak_points.length === 0 && profile.goals.length === 0
    && (prefs.explanation_style === null || prefs.explanation_style === undefined)
    && (prefs.language === null || prefs.language === undefined)
    && (prefs.pace === null || prefs.pace === undefined)
    && prefs.others.length === 0
    && (profile.recent_status === null || profile.recent_status === undefined
      || profile.recent_status.trim() === '');
}

/** Rust `LearnerProfile::enforce_char_limit` (auto path). */
export function enforceProfileCharLimit(profile: LearnerProfile): boolean {
  let trimmed = false;

  profile.weak_points.sort((a, b) => b.evidence_count - a.evidence_count);
  if (profile.weak_points.length > MAX_WEAK_POINTS) {
    profile.weak_points = profile.weak_points.slice(0, MAX_WEAK_POINTS);
    trimmed = true;
  }
  if (profile.goals.length > MAX_GOALS) {
    profile.goals = profile.goals.slice(0, MAX_GOALS);
    trimmed = true;
  }
  if (profile.preferences.others.length > MAX_OTHER_PREFERENCES) {
    profile.preferences.others = profile.preferences.others.slice(0, MAX_OTHER_PREFERENCES);
    trimmed = true;
  }
  if (profile.recent_status !== null && profile.recent_status !== undefined
    && Array.from(profile.recent_status).length > MAX_RECENT_STATUS_CHARS) {
    profile.recent_status = Array.from(profile.recent_status)
      .slice(0, MAX_RECENT_STATUS_CHARS).join('');
    trimmed = true;
  }

  while (renderedCharCount(profile) > LEARNER_PROFILE_MAX_CHARS) {
    if (profile.weak_points.length > 1) {
      profile.weak_points.pop();
    } else if (profile.goals.length > 1) {
      profile.goals.pop();
    } else if (profile.preferences.others.length > 0) {
      profile.preferences.others.pop();
    } else if (profile.recent_status !== null && profile.recent_status !== undefined) {
      profile.recent_status = null;
    } else {
      const first = profile.weak_points[0];
      if (first !== undefined && Array.from(first.error_pattern).length > 100) {
        first.error_pattern = Array.from(first.error_pattern).slice(0, 100).join('');
        trimmed = true;
        continue;
      }
      break;
    }
    trimmed = true;
  }

  return trimmed;
}

function weakPointJson(wp: WeakPoint): Record<string, unknown> {
  return {
    subject: wp.subject,
    knowledge_point: wp.knowledge_point,
    error_pattern: wp.error_pattern,
    evidence_count: wp.evidence_count,
    last_seen: wp.last_seen ?? null,
    ...(wp.source === null || wp.source === undefined ? {} : { source: wp.source }),
  };
}

/** Rust `LearnerProfile::to_json` (persisted reserved-note shape, fingerprint included). */
export function learnerProfileToJson(profile: LearnerProfile): string {
  const value: Record<string, unknown> = {
    version: profile.version,
    updated_at: profile.updated_at,
    weak_points: profile.weak_points.map(weakPointJson),
    preferences: {
      explanation_style: profile.preferences.explanation_style ?? null,
      language: profile.preferences.language ?? null,
      pace: profile.preferences.pace ?? null,
      others: [...profile.preferences.others],
    },
    goals: profile.goals.map(goal => ({
      goal: goal.goal, deadline: goal.deadline ?? null,
    })),
    recent_status: profile.recent_status ?? null,
  };
  if (profile.last_promotion_fingerprint !== null
    && profile.last_promotion_fingerprint !== undefined) {
    value[PROMOTION_FINGERPRINT_JSON_KEY] = profile.last_promotion_fingerprint;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
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
    || lastSeen === undefined && value['last_seen'] !== undefined
    || source === undefined && value['source'] !== undefined) {
    return null;
  }
  return {
    subject: typeof subject === 'string' ? subject : '',
    knowledge_point: typeof point === 'string' ? point : '',
    error_pattern: typeof pattern === 'string' ? pattern : '',
    evidence_count: typeof evidence === 'number' ? evidence : 0,
    last_seen: lastSeen ?? null,
    ...(source === null || source === undefined ? {} : { source }),
  };
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
    goals.push({ goal: typeof goal === 'string' ? goal : '', deadline: deadline ?? null });
  }
  return goals;
}

function parsePreferences(value: unknown): LearnerPreferences | null {
  if (!isRecord(value)) return null;
  const explanation = optionalString(value['explanation_style']);
  const language = optionalString(value['language']);
  const pace = optionalString(value['pace']);
  const others = value['others'];
  if ((explanation === undefined && value['explanation_style'] !== undefined)
    || (language === undefined && value['language'] !== undefined)
    || (pace === undefined && value['pace'] !== undefined)
    || (others !== undefined && (!Array.isArray(others)
      || others.some(item => typeof item !== 'string')))) {
    return null;
  }
  return {
    explanation_style: explanation ?? null,
    language: language ?? null,
    pace: pace ?? null,
    others: others === undefined ? [] : [...others as string[]],
  };
}

/** serde_json reads `1.0`, `1e0` and `-0` as f64; a `u32` field rejects them. */
class JsonFloatLiteral {
  readonly value: number;
  constructor(value: number) { this.value = value; }
}

/** `serde_json::Value` parse that keeps the integer/float lexical kind of numbers. */
function parseJsonKeepingNumberKind(raw: string): unknown {
  const reviver = (_key: string, value: unknown, context?: { source?: string }): unknown => {
    if (typeof value !== 'number') return value;
    const source = context?.source;
    if (source === undefined) throw new Error('JSON.parse source access is required');
    return /^-?(0|[1-9][0-9]*)$/u.test(source) && source !== '-0' ? value : new JsonFloatLiteral(value);
  };
  return JSON.parse(raw, reviver as (key: string, value: unknown) => unknown);
}

/**
 * Rust `LearnerProfile::from_json` (learner_profile.rs:506-514): `Value` first, then typed
 * `from_value` (missing fields default, wrong types reject, u32 rejects float literals);
 * `_promotion_fingerprint` is read with `as_str` only, so a non-string is ignored as None.
 */
export function learnerProfileFromJson(raw: string): LearnerProfile | null {
  let value: unknown;
  try {
    value = parseJsonKeepingNumberKind(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const version = value['version'];
  const updatedAt = value['updated_at'];
  const recentStatus = optionalString(value['recent_status']);
  const fingerprintValue = value[PROMOTION_FINGERPRINT_JSON_KEY];
  const fingerprint = typeof fingerprintValue === 'string' ? fingerprintValue : null;
  if ((version !== undefined && (typeof version !== 'number' || !Number.isInteger(version)
      || version < 0 || version > 0xffffffff))
    || (updatedAt !== undefined && typeof updatedAt !== 'string')
    || (recentStatus === undefined && value['recent_status'] !== undefined)) {
    return null;
  }
  const weakPointsRaw = value['weak_points'];
  let weakPoints: WeakPoint[] = [];
  if (weakPointsRaw !== undefined) {
    if (!Array.isArray(weakPointsRaw)) return null;
    for (const item of weakPointsRaw) {
      const parsed = parseWeakPoint(item);
      if (parsed === null) return null;
      weakPoints.push(parsed);
    }
  }
  const goals = value['goals'] === undefined ? [] : parseGoals(value['goals']);
  if (goals === null) return null;
  const preferences = value['preferences'] === undefined
    ? { others: [] } : parsePreferences(value['preferences']);
  if (preferences === null) return null;
  return {
    version: typeof version === 'number' ? version : 0,
    updated_at: typeof updatedAt === 'string' ? updatedAt : '',
    weak_points: weakPoints,
    preferences,
    goals,
    recent_status: recentStatus ?? null,
    last_promotion_fingerprint: fingerprint,
  };
}

/** Rust `is_learner_profile_json_shape` (strict key presence, not deserializability). */
export function isLearnerProfileJsonShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return ['version', 'updated_at', 'weak_points', 'preferences', 'goals']
    .every(key => Object.prototype.hasOwnProperty.call(value, key));
}

/** Rust `merge_profile_json_for_sync`: returns merged JSON or null for non-profile rows. */
export function mergeProfileJsonForSync(localJson: string, remoteJson: string): string | null {
  let localValue: unknown;
  let remoteValue: unknown;
  try {
    localValue = JSON.parse(localJson);
    remoteValue = JSON.parse(remoteJson);
  } catch (error) {
    return null;
  }
  if (!isLearnerProfileJsonShape(localValue) || !isLearnerProfileJsonShape(remoteValue)) {
    return null;
  }
  const local = learnerProfileFromJson(localJson);
  const remote = learnerProfileFromJson(remoteJson);
  if (local === null || remote === null) return null;
  return learnerProfileToJson(mergeProfilesForSync(local, remote));
}

/** Rust `merge_profiles_for_sync` (symmetric merge, newer side wins ties). */
export function mergeProfilesForSync(a: LearnerProfile, b: LearnerProfile): LearnerProfile {
  let aIsNewer: boolean;
  if (a.updated_at !== b.updated_at) aIsNewer = a.updated_at > b.updated_at;
  else if (a.version !== b.version) aIsNewer = a.version > b.version;
  else aIsNewer = learnerProfileToJson(a) >= learnerProfileToJson(b);
  const newer = aIsNewer ? a : b;
  const older = aIsNewer ? b : a;

  const weakPoints = newer.weak_points.map(wp => ({
    ...wp,
    ...(wp.source === null || wp.source === undefined ? {} : { source: wp.source }),
  }));
  for (const oldWp of older.weak_points) {
    const existing = weakPoints.find(wp =>
      weakPointKeyEq(wp.subject, wp.knowledge_point, oldWp.subject, oldWp.knowledge_point));
    if (existing !== undefined) {
      if (oldWp.evidence_count > existing.evidence_count) {
        Object.assign(existing, oldWp);
      }
    } else {
      weakPoints.push({
        ...oldWp,
        ...(oldWp.source === null || oldWp.source === undefined ? {} : { source: oldWp.source }),
      });
    }
  }

  const goals = newer.goals.map(goal => ({ ...goal }));
  for (const oldGoal of older.goals) {
    if (!goals.some(goal => goal.goal.trim() === oldGoal.goal.trim())) {
      goals.push({ ...oldGoal });
    }
  }

  const merged: LearnerProfile = {
    version: Math.min(0xffffffff, Math.max(newer.version, older.version) + 1),
    updated_at: newer.updated_at,
    weak_points: weakPoints,
    preferences: {
      others: [...newer.preferences.others],
      explanation_style: newer.preferences.explanation_style ?? null,
      language: newer.preferences.language ?? null,
      pace: newer.preferences.pace ?? null,
    },
    goals,
    recent_status: newer.recent_status ?? null,
    last_promotion_fingerprint: newer.last_promotion_fingerprint ?? null,
  };
  enforceProfileCharLimit(merged);
  return merged;
}

/** Rust `dedupe_profile_versions_keep_last` (BTreeMap: ascending version, last wins). */
export function dedupeProfileVersionsKeepLast(versions: readonly LearnerProfile[]): LearnerProfile[] {
  const byVersion = new Map<number, LearnerProfile>();
  for (const profile of versions) byVersion.set(profile.version, profile);
  return [...byVersion.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, profile]) => profile);
}

/** `serde_json::to_value(&profile)`: serde field order, `last_promotion_fingerprint` skipped. */
export function learnerProfilePublicValue(profile: LearnerProfile): Record<string, unknown> {
  return JSON.parse(learnerProfileToJson({ ...profile, last_promotion_fingerprint: null })) as Record<string, unknown>;
}

/** Generic API serialization omits the internal promotion marker (`serde(skip)`). */
export function learnerProfilePublicJson(profile: LearnerProfile): string {
  const { last_promotion_fingerprint, ...rest } = profile;
  void last_promotion_fingerprint;
  return JSON.stringify(rest);
}
