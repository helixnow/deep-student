/**
 * 作文工作台的内容状态、脏检查基准与会话级持久化辅助。
 *
 * 从 EssayGradingWorkbench 抽出为纯函数模块，便于单元测试：
 * - 脏检查快照：正文 + 题目 + 两类图片，任一变化即视为有未保存修改；
 * - 轮次切换决策：批改中/越界/同轮忽略，脏正文需确认；
 * - 题目/图片的会话级持久化：批改轮次表只落正文与批改结果，
 *   题目与原图在批改完成后以 JSON 存入 settings KV（键按 sessionId 区分），
 *   重开会话时恢复，避免多轮迭代时上下文丢失。
 */

/** 参与脏检查/持久化的图片最小结构（UploadedImage 的结构子集） */
export interface EssayImageLike {
  id: string;
  fileName: string;
  base64: string;
  ocrText?: string;
}

/** 参与脏检查/持久化的会话内容（正文 + 题目 + 两类图片） */
export interface EssayContentState {
  inputText: string;
  topicText: string;
  uploadedImages: EssayImageLike[];
  topicImages: EssayImageLike[];
}

export function essayDirtySnapshot(state: EssayContentState): string {
  const imageKey = (image: EssayImageLike) => `${image.id}:${image.fileName}:${image.base64.length}`;
  return JSON.stringify([
    state.inputText,
    state.topicText,
    state.uploadedImages.map(imageKey),
    state.topicImages.map(imageKey),
  ]);
}

/** 内容之外影响批改结果的配置参数 */
export interface EssayGradingConfig {
  modeId: string;
  modelId: string;
  essayType: string;
  gradeLevel: string;
  customPrompt: string;
}

/**
 * "已批改内容"快照：内容（正文/题目/图片）+ 批改配置（模式/模型/文体/学段/Prompt）。
 * 任一变化都允许发起新一轮批改（例如同一篇作文换模式重新批阅是合法操作）。
 */
export function essayGradedSnapshot(content: EssayContentState, config: EssayGradingConfig): string {
  return JSON.stringify([
    essayDirtySnapshot(content),
    config.modeId,
    config.modelId,
    config.essayType,
    config.gradeLevel,
    config.customPrompt,
  ]);
}

// ============================================================================
// 轮次切换决策
// ============================================================================

export type RoundSwitchDecision = 'ignore' | 'needs-confirm' | 'apply';

/**
 * 轮次切换的守卫决策：
 * - 批改中/目标越界/目标即当前轮 → ignore；
 * - 正文相对当前展示轮次有未保存编辑 → needs-confirm（切换会用目标轮次正文覆盖输入区）；
 * - 其余 → apply。
 */
export function evaluateRoundSwitch(params: {
  targetIndex: number;
  currentIndex: number;
  roundCount: number;
  isGrading: boolean;
  hasUnsavedBody: boolean;
}): RoundSwitchDecision {
  if (params.isGrading) return 'ignore';
  if (params.targetIndex < 0 || params.targetIndex >= params.roundCount) return 'ignore';
  if (params.targetIndex === params.currentIndex) return 'ignore';
  return params.hasUnsavedBody ? 'needs-confirm' : 'apply';
}

// ============================================================================
// 题目/图片的会话级持久化（settings KV 序列化）
// ============================================================================

export interface PersistedEssayImage {
  id: string;
  fileName: string;
  base64: string;
  ocrText?: string;
}

export interface EssaySessionContext {
  version: 1;
  topicText: string;
  uploadedImages: PersistedEssayImage[];
  topicImages: PersistedEssayImage[];
}

export const essaySessionContextKey = (sessionId: string) =>
  `essay_grading.session_context.${sessionId}`;

/** 按文件扩展名猜测预览用 MIME（持久化只存 base64，dataUrl 恢复时重建） */
export function guessImageMime(fileName: string): string {
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg';
}

export function toPersistedImages(images: EssayImageLike[]): PersistedEssayImage[] {
  return images.map(img => ({
    id: img.id,
    fileName: img.fileName,
    base64: img.base64,
    ocrText: img.ocrText || undefined,
  }));
}

/** 从持久化记录恢复出的图片（含重建的 dataUrl，OCR 终态视为已完成） */
export interface RestoredEssayImage {
  id: string;
  fileName: string;
  base64: string;
  ocrText: string;
  dataUrl: string;
  ocrStatus: 'done';
}

export function fromPersistedImages(images: unknown): RestoredEssayImage[] {
  if (!Array.isArray(images)) return [];
  return images
    .filter((img): img is PersistedEssayImage =>
      !!img && typeof img === 'object' &&
      typeof (img as PersistedEssayImage).id === 'string' &&
      typeof (img as PersistedEssayImage).fileName === 'string' &&
      typeof (img as PersistedEssayImage).base64 === 'string' &&
      (img as PersistedEssayImage).base64.length > 0
    )
    .map(img => ({
      id: img.id,
      fileName: img.fileName,
      base64: img.base64,
      ocrText: typeof img.ocrText === 'string' ? img.ocrText : '',
      dataUrl: `data:${guessImageMime(img.fileName)};base64,${img.base64}`,
      ocrStatus: 'done' as const,
    }));
}

export function serializeSessionContext(state: Omit<EssayContentState, 'inputText'>): string {
  const context: EssaySessionContext = {
    version: 1,
    topicText: state.topicText,
    uploadedImages: toPersistedImages(state.uploadedImages),
    topicImages: toPersistedImages(state.topicImages),
  };
  return JSON.stringify(context);
}

export function parseSessionContext(raw: string | null | undefined): EssaySessionContext | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Partial<EssaySessionContext>;
    return {
      version: 1,
      topicText: typeof record.topicText === 'string' ? record.topicText : '',
      uploadedImages: Array.isArray(record.uploadedImages) ? record.uploadedImages : [],
      topicImages: Array.isArray(record.topicImages) ? record.topicImages : [],
    };
  } catch {
    return null;
  }
}
