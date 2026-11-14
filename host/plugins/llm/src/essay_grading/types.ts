/**
 * 作文批改类型与预置模式（移植 `dstu-tutor/src/essay_grading/types.rs`）。
 *
 * 类型字段沿用 Rust 语义的 camelCase 命名；IPC 载荷（snake_case）通过
 * `gradingRequestFromWire` 等解码函数转换。
 */
import { BUILTIN_GRADING_MODE_SEEDS } from './builtin_modes_data.ts';
import { toRfc3339 } from '../../../../platform/time/index.ts';

// ============================================================================
// 批阅模式
// ============================================================================

export interface ScoreDimension {
  /** 维度名称（同时用于 `<dim name="...">` 解析） */
  name: string;
  /** 维度满分 */
  maxScore: number;
  /** 维度描述 */
  description: string | null;
}

export interface GradingMode {
  /** 模式 ID */
  id: string;
  /** 模式名称 */
  name: string;
  /** 模式描述 */
  description: string;
  /** 系统提示词 */
  systemPrompt: string;
  /** 评分维度配置 */
  scoreDimensions: ScoreDimension[];
  /** 总分满分 */
  totalMaxScore: number;
  /** 是否预置模式 */
  isBuiltin: boolean;
  /** 创建时间（RFC 3339） */
  createdAt: string;
  /** 更新时间（RFC 3339） */
  updatedAt: string;
}

// ============================================================================
// 评分结果
// ============================================================================

/** 等级代码（与前端 GradeCode 对齐，由组件层翻译） */
export type GradeCode = 'excellent' | 'good' | 'pass' | 'fail';

export interface DimensionScore {
  name: string;
  score: number;
  maxScore: number;
  comment: string | null;
}

export interface ParsedScore {
  total: number;
  maxTotal: number;
  grade: GradeCode;
  dimensions: DimensionScore[];
}

// ============================================================================
// 批改请求 / 响应
// ============================================================================

export interface GradingRequest {
  sessionId: string;
  streamSessionId: string;
  roundNumber: number;
  inputText: string;
  topic: string | null;
  modeId: string | null;
  modelConfigId: string | null;
  /** 兼容旧版（优先使用 modeId） */
  essayType: string;
  /** 兼容旧版（优先使用 modeId） */
  gradeLevel: string;
  customPrompt: string | null;
  previousResult: string | null;
  previousInput: string | null;
  imageBase64List: string[] | null;
  topicImageBase64List: string[] | null;
  /**
   * 反馈语言（"zh-CN" | "en-US"）；缺省时保持历史行为（中文评语）。
   * 只影响评语/解释语言，不影响作文原文、标记语义与 `<dim>` 维度名。
   */
  responseLanguage: string | null;
}

export interface GradingResponse {
  roundId: string;
  sessionId: string;
  roundNumber: number;
  gradingResult: string;
  overallScore: number | null;
  dimensionScoresJson: string | null;
  createdAt: string;
}

export interface GradingRoundResponse {
  id: string;
  sessionId: string;
  roundNumber: number;
  inputText: string;
  gradingResult: string;
  overallScore: number | null;
  dimensionScoresJson: string | null;
  createdAt: string;
}

export interface GradingStreamData {
  type: 'data';
  chunk: string;
  charCount: number;
}

export interface GradingStreamComplete {
  type: 'complete';
  roundId: string;
  gradingResult: string;
  overallScore: number | null;
  parsedScore: string | null;
  createdAt: string;
}

/** stage 取值：preparing / annotating / polishing / model_essay / scoring / saving */
export interface GradingStreamProgress {
  type: 'progress';
  stage: string;
  charCount: number;
}

export interface GradingStreamError {
  type: 'error';
  message: string;
}

export interface GradingStreamCancelled {
  type: 'cancelled';
}

// ============================================================================
// 预置模式
// ============================================================================

/** 获取预置批阅模式列表（每次返回独立副本，时间戳为当前时刻） */
export function getBuiltinGradingModes(): GradingMode[] {
  const now = toRfc3339();
  return BUILTIN_GRADING_MODE_SEEDS.map((seed) => ({
    ...seed,
    scoreDimensions: seed.scoreDimensions.map((dim) => ({ ...dim })),
    createdAt: now,
    updatedAt: now,
  }));
}

/** 获取默认批阅模式（日常练习） */
export function getDefaultGradingMode(): GradingMode {
  const practice = getBuiltinGradingModes().find((mode) => mode.id === 'practice');
  if (practice === undefined) {
    throw new Error("builtin grading modes must contain the 'practice' default mode");
  }
  return practice;
}

/** 归一化预置模式 ID，兼容历史或外部调用别名 */
export function canonicalModeId(modeId: string): string {
  switch (modeId.trim()) {
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
      return modeId.trim();
  }
}

// ============================================================================
// Wire 解码（对应 serde Deserialize）
// ============================================================================

function requiredString(wire: Record<string, unknown>, key: string): string {
  const value = wire[key];
  if (typeof value !== 'string') {
    throw new TypeError(`GradingRequest.${key} 必须是字符串`);
  }
  return value;
}

function optionalString(wire: Record<string, unknown>, key: string): string | null {
  const value = wire[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new TypeError(`GradingRequest.${key} 必须是字符串`);
  }
  return value;
}

function optionalStringList(wire: Record<string, unknown>, key: string): string[] | null {
  const value = wire[key];
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TypeError(`GradingRequest.${key} 必须是字符串数组`);
  }
  return value as string[];
}

/**
 * 解码批改请求载荷（`response_language` 等字段缺省时按 Rust serde 默认值处理）。
 */
export function gradingRequestFromWire(wire: Record<string, unknown>): GradingRequest {
  const roundNumber = wire['round_number'];
  if (typeof roundNumber !== 'number' || !Number.isInteger(roundNumber)) {
    throw new TypeError('GradingRequest.round_number 必须是整数');
  }
  return {
    sessionId: requiredString(wire, 'session_id'),
    streamSessionId: requiredString(wire, 'stream_session_id'),
    roundNumber,
    inputText: requiredString(wire, 'input_text'),
    topic: optionalString(wire, 'topic'),
    modeId: optionalString(wire, 'mode_id'),
    modelConfigId: optionalString(wire, 'model_config_id'),
    essayType: requiredString(wire, 'essay_type'),
    gradeLevel: requiredString(wire, 'grade_level'),
    customPrompt: optionalString(wire, 'custom_prompt'),
    previousResult: optionalString(wire, 'previous_result'),
    previousInput: optionalString(wire, 'previous_input'),
    imageBase64List: optionalStringList(wire, 'image_base64_list'),
    topicImageBase64List: optionalStringList(wire, 'topic_image_base64_list'),
    responseLanguage: optionalString(wire, 'response_language'),
  };
}
