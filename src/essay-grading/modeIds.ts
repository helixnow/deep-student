/**
 * 批阅模式 ID 归一（与 Rust `essay_grading::types::canonical_mode_id` 保持一致）
 *
 * 独立成零依赖模块：展示层（modeI18n）需要它，但不应连带拉入 essayGradingApi 的
 * invoke / 全局 i18n 初始化。
 */
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
