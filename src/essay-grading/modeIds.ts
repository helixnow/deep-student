/**
 * 批阅模式 ID 归一（与 Rust `essay_grading::types::canonical_mode_id` 保持一致）
 *
 * 独立成零依赖模块：展示层（modeI18n）需要它，但不应连带拉入 essayGradingApi 的
 * invoke / 全局 i18n 初始化。
 */
import type { GradingMode } from './essayGradingApi';

export const LOCAL_CUSTOM_RUBRICS_STORAGE_KEY = 'ds.essay_grading.custom_rubrics.v1';
export const ESSAY_SELECTED_MODE_STORAGE_KEY = 'ds.essay_grading.selected_mode_id.v1';
export const LOCAL_CUSTOM_MODE_PREFIX = 'local_custom_';

export function isLocalCustomModeId(modeId: string | null | undefined): boolean {
  return typeof modeId === 'string' && modeId.startsWith(LOCAL_CUSTOM_MODE_PREFIX);
}

export function readLocalCustomModes(): GradingMode[] {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  try {
    const raw = window.localStorage.getItem(LOCAL_CUSTOM_RUBRICS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is GradingMode =>
          Boolean(item) &&
          typeof item.id === 'string' &&
          typeof item.name === 'string' &&
          item.name.trim().length > 0 &&
          typeof item.system_prompt === 'string',
      )
      .map((item) => ({
        ...item,
        is_builtin: false,
        total_max_score:
          typeof item.total_max_score === 'number' && Number.isFinite(item.total_max_score) && item.total_max_score > 0
            ? item.total_max_score
            : 100,
        score_dimensions: Array.isArray(item.score_dimensions) ? item.score_dimensions : [],
        description: typeof item.description === 'string' ? item.description : '',
        created_at: typeof item.created_at === 'string' ? item.created_at : new Date().toISOString(),
        updated_at: typeof item.updated_at === 'string' ? item.updated_at : new Date().toISOString(),
      }));
  } catch {
    return [];
  }
}

function writeLocalCustomModes(modes: GradingMode[]): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(LOCAL_CUSTOM_RUBRICS_STORAGE_KEY, JSON.stringify(modes));
  } catch {
    // Ignore storage quota errors.
  }
}

export function saveLocalCustomMode(input: {
  id?: string;
  name: string;
  description?: string;
  system_prompt: string;
  total_max_score?: number;
  score_dimensions?: GradingMode['score_dimensions'];
}): GradingMode {
  const now = new Date().toISOString();
  const existing = readLocalCustomModes();
  const existingMatch = input.id ? existing.find((m) => m.id === input.id) : undefined;
  const id = existingMatch?.id ?? `${LOCAL_CUSTOM_MODE_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const nextMode: GradingMode = {
    id,
    name: input.name.trim(),
    description: (input.description ?? '').trim(),
    system_prompt: input.system_prompt.trim(),
    score_dimensions: input.score_dimensions && input.score_dimensions.length > 0 ? input.score_dimensions : [],
    total_max_score:
      typeof input.total_max_score === 'number' && Number.isFinite(input.total_max_score) && input.total_max_score > 0
        ? input.total_max_score
        : 100,
    is_builtin: false,
    created_at: existingMatch?.created_at ?? now,
    updated_at: now,
  };
  const nextList = existingMatch
    ? existing.map((m) => (m.id === id ? nextMode : m))
    : [...existing, nextMode];
  writeLocalCustomModes(nextList);
  return nextMode;
}

export function deleteLocalCustomMode(modeId: string): void {
  const existing = readLocalCustomModes();
  const nextList = existing.filter((m) => m.id !== modeId);
  writeLocalCustomModes(nextList);
}

export function mergeModesWithLocalCustom(serverModes: GradingMode[]): GradingMode[] {
  const localModes = readLocalCustomModes();
  if (localModes.length === 0) return serverModes;
  const seen = new Set(serverModes.map((m) => m.id));
  const merged = [...serverModes];
  for (const local of localModes) {
    if (!seen.has(local.id)) {
      merged.push(local);
      seen.add(local.id);
    }
  }
  return merged;
}

export function resolveBackendGradingPayload(params: {
  modeId: string;
  activeMode?: GradingMode;
  customPrompt: string;
  defaultPromptText: string;
}): {
  modeIdForBackend: string | undefined;
  customPromptForBackend: string | undefined;
  isLocalCustom: boolean;
} {
  const trimmedExtra = params.customPrompt.trim();
  const hasExplicitExtra =
    trimmedExtra.length > 0 && trimmedExtra !== params.defaultPromptText.trim();
  const localRubric = isLocalCustomModeId(params.modeId)
    ? (params.activeMode ?? readLocalCustomModes().find((m) => m.id === params.modeId))
    : undefined;

  if (localRubric) {
    const dimText = localRubric.score_dimensions.length > 0
      ? `\nDimensions (${localRubric.total_max_score} total): ${localRubric.score_dimensions
          .map((d) => `${d.name} (${d.max_score})`)
          .join(', ')}`
      : '';
    const rubricHeader = `[Custom Rubric: ${localRubric.name} · Max Score ${localRubric.total_max_score}]${dimText}\n${localRubric.system_prompt}`;
    const combinedPrompt = hasExplicitExtra
      ? `${rubricHeader}\n\n${trimmedExtra}`
      : rubricHeader;
    return {
      // Backend requires a persisted or builtin mode_id; anchor on 'practice' and inject the full custom rubric via custom_prompt.
      modeIdForBackend: 'practice',
      customPromptForBackend: combinedPrompt,
      isLocalCustom: true,
    };
  }

  if (isLocalCustomModeId(params.modeId)) {
    return {
      modeIdForBackend: 'practice',
      customPromptForBackend: trimmedExtra || undefined,
      isLocalCustom: true,
    };
  }

  return {
    modeIdForBackend: params.modeId || undefined,
    customPromptForBackend: params.customPrompt || undefined,
    isLocalCustom: false,
  };
}

export function canonicalizeEssayModeId(modeId: string): string {
  const trimmed = modeId.trim();
  switch (trimmed) {
    case 'ielts_task2':
    case 'ielts_writing':
      return 'ielts';
    case 'ielts_task_1':
      return 'ielts_task1';
    case 'cet4':
    case 'cet6':
    case 'cet46':
    case 'cet_46':
      return 'cet';
    case 'gaokao_english_short':
    case 'gaokao_eng_short':
      return 'gaokao_en_short';
    case 'gaokao_english_long':
    case 'gaokao_eng_long':
    case 'gaokao_en_continuation':
      return 'gaokao_en_long';
    default:
      return trimmed;
  }
}

export type EssayGradeLevel = 'middle_school' | 'high_school' | 'college' | 'other';

const EXAM_RUBRIC_NO_SCHOOL_GRADE = new Set(['ielts', 'ielts_task1', 'toefl']);
const COLLEGE_EXAM_MODES = new Set(['cet', 'kaoyan', 'kaoyan_en']);
const HIGH_SCHOOL_MODES = new Set(['gaokao', 'gaokao_en_short', 'gaokao_en_long']);

export function recommendedGradeLevelForMode(
  modeId: string,
  isBuiltin = true,
): EssayGradeLevel | null {
  const canonical = canonicalizeEssayModeId(modeId);
  if (!isBuiltin || EXAM_RUBRIC_NO_SCHOOL_GRADE.has(canonical)) {
    return 'other';
  }
  if (COLLEGE_EXAM_MODES.has(canonical)) {
    return 'college';
  }
  if (canonical === 'zhongkao') {
    return 'middle_school';
  }
  if (HIGH_SCHOOL_MODES.has(canonical)) {
    return 'high_school';
  }
  return null;
}

export function shouldSuppressHighSchoolPollution(params: {
  modeId: string;
  isBuiltin?: boolean;
  gradeLevel?: string;
  hasCustomPrompt?: boolean;
}): boolean {
  const canonical = canonicalizeEssayModeId(params.modeId);
  if (!params.isBuiltin || EXAM_RUBRIC_NO_SCHOOL_GRADE.has(canonical)) {
    return true;
  }
  if (
    (params.gradeLevel === undefined || params.gradeLevel === 'high_school') &&
    (COLLEGE_EXAM_MODES.has(canonical) || params.hasCustomPrompt)
  ) {
    return true;
  }
  return false;
}
