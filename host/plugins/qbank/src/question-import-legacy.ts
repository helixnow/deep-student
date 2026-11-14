/**
 * `question_import_service.rs::resume_import` 的旧版 checkpoint 状态机（822-1197）及其 L14 自有辅助函数：
 * `ImportCheckpointState`（257-318）、`save_checkpoint`（3723）、`rebuild_preview_from_questions`（3814）、
 * `json_to_question_params`（3168）、`contains_option_marker`（3140）、`no_questions_error`（3340）、
 * `build_text_parse_prompt`（3347）、`segment_document`（3663）。
 *
 * 分支归属：
 * - DocxVlmDirectDone 收尾、纯文本分块恢复：本文件完整实现（纯文本经 L02 已发布的
 *   `llmQuestionParsing.parseStreaming` = `call_llm_for_question_parsing_streaming`）。
 * - DocxVlmDirect / DOCX 原生 / Visual-First：L14 编排在 `question-import-legacy-vision.ts`，视觉能力经
 *   L18 `questionImportVision`（VlmGroundingService / cross_page_merger / figure_extractor / llm_structurer）。
 */
import { nanoid } from 'nanoid';
import { AppError } from '../../../platform/errors/api.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';
import type { LlmQuestionParsing } from '../../llm/api.ts';
import type { QuestionImportVisionService } from '../../media/api.ts';
import type { BlobRepository } from '../../vfs-repos/api.ts';
import { LATEX_OUTPUT_BRIEF } from '../../llm-providers/api.ts';
import type {
  CreateQuestionParams, Difficulty, Question, QuestionOption, QuestionType,
} from '../../vfs-repos/api.ts';
import type { QuestionImportProgress } from '../api.ts';
import {
  SerdeDecodeError, dflt, fromStr, map, opt, req, string, struct, unitEnum, usize, u32, vec, type Decoder,
} from '../repository/serde-decode.ts';
import { defaultExamCardBBoxJson } from './exam-card-bbox.ts';
import { QbankServiceError } from './question-service.ts';
import type { ImportResult, ImportRun, ImportServiceHost, ProgressSink } from './question-import-service.ts';
import { toAppError } from './question-import-service.ts';
import {
  rebuildPagesFromCheckpoint, resumeDocxVlmDirect, runDocxPipelineFromVlm, runVisualPipelineFromStage2,
} from './question-import-legacy-vision.ts';

type JsonObject = { [key: string]: JsonValue };

/**
 * `dstu-core/src/prompt_contracts.rs:57 DIFFICULTY_RUBRIC`（逐字）。dstu-core 归 F4，
 * Host 尚未发布该常量（`LATEX_OUTPUT_BRIEF` 已由 llm-providers 发布）；发布后改为引用。
 */
const DIFFICULTY_RUBRIC = `**difficulty 判定标准**（逐题按题目本身的特征判断）：
- "easy"：直接记忆或套用单一公式即可作答。特征：概念定义、名词解释、单一公式代入、课本原句改编。
- "medium"：需要 1-2 步推理或知识点组合，无跨章综合。特征：常规选择题、简单计算、概念理解辨析。
- "hard"：需要多步推理、跨知识点综合，或含易混淆的干扰项。特征：综合计算、机理/情境分析、多个知识点的关联应用。
- "very_hard"：需要复杂推导、创造性综合或冷门细节。特征：压轴题、多过程计算、高度综合的论述、竞赛级难度。
- 参考信号（按优先级）：计算复杂度 > 干扰项迷惑性 > 是否跨章节 > 知识点冷门程度；题目标注的分值或来源（如高考真题、竞赛题）可作佐证。
- 不要因为拿不准就一律给 "medium"；只有题目信息确实不足以判断时才用 "medium"。`;

// ---------------------------------------------------------------------------
// ImportCheckpointState

export const IMPORT_STAGES = [
  'rasterized', 'vlm_analyzing', 'vlm_completed', 'figures_extracted', 'structuring', 'completed',
  'docx_extracted', 'docx_vlm_describing', 'docx_vlm_done', 'docx_structuring',
  'docx_vlm_direct', 'docx_vlm_direct_done',
] as const;
export type ImportStage = typeof IMPORT_STAGES[number];

export interface DocxImageEntrySerde { marker_index: number; blob_hash: string; mime: string; ext: string }

/** `ImportCheckpointState`（字段序即 serde 输出序）。 */
export interface ImportCheckpointState {
  qbank_name: string;
  model_config_id: string | null;
  source_format: string;
  current_stage: ImportStage;
  page_blob_hashes: string[];
  vlm_pages_completed: number;
  vlm_page_results: string[];
  structuring_batches_completed: number;
  structured_batch_results: string[];
  page_dimensions: [number, number][];
  source_image_hashes: string[];
  import_mode: string;
  text_content: string;
  chunks_total: number;
  chunks_completed: number;
  docx_image_entries: DocxImageEntrySerde[];
  docx_vlm_descriptions: Record<string, string>;
  docx_vlm_images_completed: number;
  docx_enriched_text: string;
  docx_marker_positions: [number, number][];
  docx_vlm_direct_blob_hashes: string[];
  docx_vlm_direct_mimes: string[];
  docx_vlm_direct_exts: string[];
  docx_vlm_direct_text: string;
  docx_vlm_direct_saved: number;
}

function tuple2<T>(inner: Decoder<T>): Decoder<[T, T]> {
  return (value, path) => {
    if (!Array.isArray(value)) throw new SerdeDecodeError(`invalid type: expected a tuple of size 2 at ${path}`);
    if (value.length !== 2) throw new SerdeDecodeError(`invalid length ${value.length}, expected a tuple of size 2 at ${path}`);
    return [inner(value[0], `${path}[0]`), inner(value[1], `${path}[1]`)];
  };
}

const docxImageEntry = struct<DocxImageEntrySerde>('DocxImageEntrySerde', {
  marker_index: req(usize), blob_hash: req(string), mime: req(string), ext: req(string),
});

const empty = <T>(value: T) => () => value;

const checkpointDecoder = struct<ImportCheckpointState>('ImportCheckpointState', {
  qbank_name: req(string),
  model_config_id: opt(string),
  source_format: req(string),
  current_stage: dflt(unitEnum(IMPORT_STAGES), empty('rasterized')),
  page_blob_hashes: req(vec(string)),
  vlm_pages_completed: dflt(usize, empty(0)),
  vlm_page_results: dflt(vec(string), () => []),
  structuring_batches_completed: dflt(usize, empty(0)),
  structured_batch_results: dflt(vec(string), () => []),
  page_dimensions: dflt(vec(tuple2(u32)), () => []),
  source_image_hashes: dflt(vec(string), () => []),
  import_mode: dflt(string, empty('')),
  text_content: dflt(string, empty('')),
  chunks_total: dflt(usize, empty(0)),
  chunks_completed: dflt(usize, empty(0)),
  docx_image_entries: dflt(vec(docxImageEntry), () => []),
  docx_vlm_descriptions: dflt(map(string), () => ({})),
  docx_vlm_images_completed: dflt(usize, empty(0)),
  docx_enriched_text: dflt(string, empty('')),
  docx_marker_positions: dflt(vec(tuple2(usize)), () => []),
  docx_vlm_direct_blob_hashes: dflt(vec(string), () => []),
  docx_vlm_direct_mimes: dflt(vec(string), () => []),
  docx_vlm_direct_exts: dflt(vec(string), () => []),
  docx_vlm_direct_text: dflt(string, empty('')),
  docx_vlm_direct_saved: dflt(usize, empty(0)),
});

/** `serde_json::from_str::<ImportCheckpointState>`，失败 → Validation「解析导入状态失败: {e}」。 */
export function parseCheckpoint(stateStr: string): ImportCheckpointState {
  try {
    return fromStr(stateStr, checkpointDecoder);
  } catch (error) {
    throw new QbankServiceError(AppError.validation(
      `解析导入状态失败: ${error instanceof Error ? error.message : String(error)}`));
  }
}

/** `save_checkpoint`：写入失败 warn 后继续。 */
export function saveCheckpoint(host: ImportServiceHost, sessionId: string, checkpoint: ImportCheckpointState): void {
  try {
    host.exams.updateImportState(host.db, sessionId, checkpoint as unknown as JsonValue);
  } catch (error) {
    host.log?.warn(`[QuestionImport] 保存 checkpoint 失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// 纯函数

/** `no_questions_error`：带上首个失败原因（trim 后非空）。 */
export function noQuestionsError(prefix: string, firstFailure: string | null): string {
  const reason = firstFailure === null ? null : rustTrim(firstFailure);
  return reason !== null && reason !== '' ? `${prefix}：${reason}` : prefix;
}

/** Rust `str::trim`（White_Space）。 */
function rustTrim(value: string): string {
  return value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
}

function rustTrimEnd(value: string): string {
  return value.replace(/\p{White_Space}+$/u, '');
}

function isRustWhitespace(char: string): boolean {
  return /^\p{White_Space}$/u.test(char);
}

/** `contains_option_marker`：字母前为空白或行首、后跟选项分隔符。 */
export function containsOptionMarker(text: string, letter: string): boolean {
  const chars = [...text];
  for (let index = 0; index < chars.length; index += 1) {
    if (chars[index] !== letter) continue;
    const prev = index === 0 ? null : chars[index - 1]!;
    if (prev !== null && !isRustWhitespace(prev)) continue;
    const next = chars[index + 1];
    if (next !== undefined && ['.', '、', '．', ':', '：'].includes(next)) return true;
  }
  return false;
}

/** `segment_document`：按段落（不足 3 段时按行）聚合到 max_tokens（字符数/2 估算）。 */
export function segmentDocument(content: string, maxTokens: number): string[] {
  let paragraphs = content.split('\n\n').filter(part => rustTrim(part) !== '');
  if (paragraphs.length < 3) paragraphs = content.split('\n').filter(part => rustTrim(part) !== '');
  const chunks: string[] = [];
  let current = '';
  let currentTokens = 0;
  for (const paragraph of paragraphs) {
    const chars = [...paragraph];
    const paragraphTokens = Math.floor(chars.length / 2);
    if (paragraphTokens > maxTokens) {
      if (current !== '') {
        chunks.push(rustTrim(current));
        current = '';
        currentTokens = 0;
      }
      const limit = maxTokens * 2;
      for (let start = 0; start < chars.length; start += limit) chunks.push(chars.slice(start, start + limit).join(''));
      continue;
    }
    if (currentTokens + paragraphTokens > maxTokens && current !== '') {
      chunks.push(rustTrim(current));
      current = paragraph;
      currentTokens = paragraphTokens;
    } else {
      if (current !== '') current += '\n\n';
      current += paragraph;
      currentTokens += paragraphTokens;
    }
  }
  if (current !== '') chunks.push(rustTrim(current));
  return chunks;
}

/** `build_text_parse_prompt`（逐字）。 */
export function buildTextParsePrompt(chunk: string): string {
  return `请将以下文本内容解析为题目列表。

**文本内容**：
${chunk}

**输出要求**：
请输出 JSON 数组格式的题目列表（只输出 JSON，不要其他任何内容）：

\`\`\`json
[
  {
    "content": "题干内容（不含选项文本）",
    "question_type": "single_choice|multiple_choice|indefinite_choice|fill_blank|short_answer|essay|calculation|proof|other",
    "options": [
      {"key": "A", "content": "选项A内容"},
      {"key": "B", "content": "选项B内容"}
    ],
    "answer": "A",
    "explanation": "解析（如有）",
    "difficulty": "easy|medium|hard|very_hard",
    "tags": ["知识点标签"]
  }
]
\`\`\`

**规则**：
1. 选择题必须将选项拆分到 options 数组，content 只保留题干
2. 题型: single_choice=单选, multiple_choice=多选, fill_blank=填空, short_answer=简答
3. 公式格式：${LATEX_OUTPUT_BRIEF}
4. difficulty 按下方判定标准逐题判断
5. tags 根据知识点自动生成

${DIFFICULTY_RUBRIC}`;
}

/** `build_text_parse_prompt_with_images`（逐字）。 */
export function buildTextParsePromptWithImages(chunk: string): string {
  return `请将以下文本内容解析为题目列表。

**重要：文本中包含图片及其描述**
文本中的 \`<<IMG:N:[图片内容: ...]>>\` 标记代表文档中嵌入的图片。方括号内是该图片的视觉描述。
例如：\`<<IMG:0:[图片内容: 一个直角三角形，斜边长5，一条直角边长3]>>\`

你必须：
1. 利用图片描述来理解题意（图片描述等同于看到原图）
2. **原样保留**整个 \`<<IMG:N:...>>\` 标记在输出中的对应位置
3. 根据图片描述判断图片属于哪道题目（题干/选项/解析）

**文本内容**：
${chunk}

**输出要求**：
请输出 JSON 数组格式的题目列表（只输出 JSON，不要其他任何内容）：

\`\`\`json
[
  {
    "content": "题干内容（保留 <<IMG:N:...>> 标记在正确位置）",
    "question_type": "single_choice|multiple_choice|indefinite_choice|fill_blank|short_answer|essay|calculation|proof|other",
    "options": [
      {"key": "A", "content": "选项A内容"},
      {"key": "B", "content": "选项B内容"}
    ],
    "answer": "A",
    "explanation": "解析（如有）",
    "difficulty": "easy|medium|hard|very_hard",
    "tags": ["知识点标签"]
  }
]
\`\`\`

**规则**：
1. 选择题必须将选项拆分到 options 数组，content 只保留题干
2. 题型: single_choice=单选, multiple_choice=多选, fill_blank=填空, short_answer=简答
3. 公式格式：${LATEX_OUTPUT_BRIEF}
4. difficulty 按下方判定标准逐题判断
5. tags 根据知识点自动生成
6. **<<IMG:N:...>> 标记必须原样保留**，不要删除、修改或翻译
7. 利用图片描述理解题意，但不要将图片描述当作文字题干

${DIFFICULTY_RUBRIC}`;
}

function getStr(value: JsonValue | undefined, key: string): string | null {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value[key];
  return typeof item === 'string' ? item : null;
}

function getArray(value: JsonValue | undefined, key: string): JsonValue[] | null {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value[key];
  return Array.isArray(item) ? item : null;
}

/** Rust `str::to_lowercase`（Unicode 小写；与 JS `toLowerCase` 对这些 ASCII/中文取值一致）。 */
function questionTypeOf(value: string): QuestionType {
  switch (value.toLowerCase()) {
    case 'single_choice': case '单选': case '单选题': return 'single_choice';
    case 'multiple_choice': case '多选': case '多选题': return 'multiple_choice';
    case 'indefinite_choice': case '不定项': return 'indefinite_choice';
    case 'fill_blank': case '填空': case '填空题': return 'fill_blank';
    case 'short_answer': case '简答': case '简答题': return 'short_answer';
    case 'essay': case '论述': case '论述题': return 'essay';
    case 'calculation': case '计算': case '计算题': return 'calculation';
    case 'proof': case '证明': case '证明题': return 'proof';
    case 'true_false': case '判断': case '判断题': case 'judgment': return 'true_false';
    case 'matching': case '匹配': case '匹配题': case '连线': case '连线题': return 'matching';
    case 'ordering': case '排序': case '排序题': return 'ordering';
    case 'numeric': case '数值': case '数值题': return 'numeric';
    default: return 'other';
  }
}

function difficultyOf(value: string): Difficulty | null {
  switch (value.toLowerCase()) {
    case 'easy': case '简单': return 'easy';
    case 'medium': case '中等': return 'medium';
    case 'hard': case '困难': return 'hard';
    case 'very_hard': case '极难': return 'very_hard';
    default: return null;
  }
}

/**
 * `json_to_question_params`。`rfind` + 字节切片与 JS `lastIndexOf` + UTF-16 切片在同一字符边界上，结果相同。
 */
export function jsonToQuestionParams(question: JsonValue, examId: string, cardId: string,
  position: number): CreateQuestionParams {
  let content = getStr(question, 'content') ?? '';
  const rawOptions = getArray(question, 'options');
  const options: QuestionOption[] | null = rawOptions === null ? null : rawOptions.flatMap(option => {
    const key = getStr(option, 'key') ?? '';
    const optionContent = getStr(option, 'content') ?? '';
    return key === '' && optionContent === '' ? [] : [{ key, content: optionContent }];
  });
  // 选择题 options 有实际内容时，移除 content 末尾重复的选项文本。
  if (options !== null && options.length >= 2 && options.some(option => option.content !== '')) {
    let bestCut = content.length;
    for (const pattern of ['\nA.', '\nA．', '\nA、', '\nA ']) {
      const position = content.lastIndexOf(pattern);
      if (position === -1) continue;
      const after = content.slice(position);
      if (containsOptionMarker(after, 'B') && containsOptionMarker(after, 'C')) bestCut = Math.min(bestCut, position);
    }
    if (bestCut < content.length) content = rustTrimEnd(content.slice(0, bestCut));
  }
  const typeText = getStr(question, 'question_type');
  const difficultyText = getStr(question, 'difficulty');
  const rawTags = getArray(question, 'tags');
  const structured = question !== null && typeof question === 'object' && !Array.isArray(question)
    ? question.structured_data : undefined;
  const params: CreateQuestionParams = {
    exam_id: examId,
    card_id: cardId,
    question_label: `Q${position + 1}`,
    content,
    options,
    answer: getStr(question, 'answer'),
    explanation: getStr(question, 'explanation'),
    question_type: typeText === null ? null : questionTypeOf(typeText),
    difficulty: difficultyText === null ? null : difficultyOf(difficultyText),
    tags: rawTags === null ? null : rawTags.filter((tag): tag is string => typeof tag === 'string'),
    source_type: 'imported',
    source_ref: null,
    images: null,
    parent_id: null,
  };
  // 只透传对象形态的 structured_data；非对象值丢弃（Rust `filter(is_object)` → None）。
  if (structured !== null && structured !== undefined && typeof structured === 'object' && !Array.isArray(structured)) {
    params.structured_data = structured;
  }
  return params;
}

/** models.rs `QuestionType`/`Difficulty`/`QuestionStatus`/`SourceType` 与仓储枚举的 serde 往返。 */
const CORE_SOURCE_TYPE: Record<string, string> = {
  ocr: 'ocr_image', imported: 'import_file', manual: 'manual_create', ai_generated: 'ai_generated',
  ocr_image: 'ocr_image', import_file: 'import_file', manual_create: 'manual_create',
};
const CORE_STATUS = new Set(['new', 'in_progress', 'mastered', 'review']);

/** `ExamCardPreview` 的 serde 输出（models.rs:397，跳过 None/空串字段）。 */
function cardPreview(question: Question, position: number): JsonObject {
  const card: JsonObject = {
    card_id: question.card_id ?? `card_${position}`,
    page_index: 0,
    question_label: question.question_label ?? `${position + 1}`,
    bbox: defaultExamCardBBoxJson(),
    ocr_text: question.content,
    tags: [...question.tags],
  };
  // question_type 的取值集合与 models::QuestionType 相同（snake_case），往返总成功。
  card.question_type = question.question_type;
  if (question.answer !== null && question.answer !== undefined) card.answer = question.answer;
  if (question.explanation !== null && question.explanation !== undefined) card.explanation = question.explanation;
  if (question.difficulty !== null && question.difficulty !== undefined) card.difficulty = question.difficulty;
  card.status = CORE_STATUS.has(question.status) ? question.status : 'new';
  card.attempt_count = 0;
  card.correct_count = 0;
  card.source_type = CORE_SOURCE_TYPE[question.source_type] ?? 'ocr_image';
  return card;
}

/** `rebuild_preview_from_questions`：读取全部题目（每页 100）重建单页预览；失败 warn 后返回。 */
export function rebuildPreviewFromQuestions(host: ImportServiceHost, sessionId: string): void {
  const questions: Question[] = [];
  for (let page = 1; ; page += 1) {
    let result;
    try {
      result = host.questions.listQuestions(host.db, sessionId, {}, page, 100);
    } catch (error) {
      host.log?.warn(`[QuestionImport] rebuild_preview: 读取题目失败: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    questions.push(...result.questions);
    if (!result.has_more) break;
  }
  if (questions.length === 0) return;
  const preview: JsonObject = {
    temp_id: '',
    exam_name: null,
    pages: [{
      page_index: 0,
      cards: questions.map(cardPreview),
      ocr_completed: false,
      parse_completed: false,
    }],
    session_id: sessionId,
  };
  try {
    host.exams.updatePreviewJson(host.db, sessionId, preview);
  } catch (error) {
    host.log?.warn(`[QuestionImport] rebuild_preview: 更新 preview 失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// 旧版 checkpoint 恢复

export interface LegacyResumeHost extends ImportServiceHost {
  readonly questionParsing: LlmQuestionParsing;
  /** L18 `questionImportVision`。 */
  readonly vision: QuestionImportVisionService;
  readonly blobs: Pick<BlobRepository, 'getBlobPath'>;
  /** L11 `ensure_vfs_file_for_blob`：返回 file id；失败抛错（调用方 warn 后回退）。 */
  ensureFileForBlob(blobHash: string, fileName: string, mime: string): string;
}

function committedResult(sessionId: string, name: string, saved: number): ImportResult {
  return {
    session_id: sessionId, name, imported_count: saved, total_questions: saved, draft_job_id: null,
    draft_version: null, draft_document: null, model_route: null, committed: true,
  };
}

function send(progress: ProgressSink, event: QuestionImportProgress): void {
  if (progress !== null) progress(event);
}

/** 收尾：`let _ = update_status/clear_import_state`（忽略失败），统计刷新失败 warn。 */
function finalize(host: ImportServiceHost, sessionId: string): void {
  try {
    host.exams.updateStatus(host.db, sessionId, 'completed');
  } catch { // boundary-allow empty-catch: question_import_service.rs:875 `let _ = update_status`，Rust 无日志
  }
  try {
    host.exams.clearImportState(host.db, sessionId);
  } catch { // boundary-allow empty-catch: question_import_service.rs:876 `let _ = clear_import_state`，Rust 无日志
  }
  try {
    host.questions.refreshStats(host.db, sessionId);
  } catch (error) {
    host.log?.warn(`[QuestionImport] 统计刷新失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** `resume_import` 822 起：旧 checkpoint 解码与分支派发。 */
export async function resumeLegacy(host: LegacyResumeHost, sessionId: string, stateStr: string,
  progress: ProgressSink, run: ImportRun): Promise<ImportResult> {
  const checkpoint = parseCheckpoint(stateStr);
  host.log?.info?.(`[QuestionImport] 恢复导入: session=${sessionId}, stage=${stageDebug(checkpoint.current_stage)}, `
    + `vlm=${checkpoint.vlm_pages_completed}/${checkpoint.page_blob_hashes.length}, `
    + `struct_batches=${checkpoint.structuring_batches_completed}`);
  const stage = checkpoint.current_stage;
  if (stage === 'docx_vlm_direct' || stage === 'docx_vlm_direct_done') {
    host.log?.info?.(`[QuestionImport] 恢复 DOCX VLM 直提: session=${sessionId}, stage=${stageDebug(stage)}, `
      + `已保存=${checkpoint.docx_vlm_direct_saved}, blobs=${checkpoint.docx_vlm_direct_blob_hashes.length}`);
    send(progress, { type: 'SessionCreated', session_id: sessionId, name: checkpoint.qbank_name, total_chunks: 1 });
    if (stage === 'docx_vlm_direct_done') return resumeDocxVlmDirectDone(host, sessionId, checkpoint, progress);
    return resumeDocxVlmDirect(host, sessionId, checkpoint, progress, run);
  }
  if (stage === 'docx_extracted' || stage === 'docx_vlm_describing' || stage === 'docx_vlm_done'
    || stage === 'docx_structuring') {
    const imageMap = checkpoint.docx_image_entries.map(entry => ({ ...entry }));
    send(progress, { type: 'SessionCreated', session_id: sessionId, name: checkpoint.qbank_name,
      total_chunks: imageMap.length + 1 });
    return runDocxPipelineFromVlm(host, sessionId, imageMap, imageMap.length > 0, checkpoint,
      checkpoint.docx_vlm_images_completed, progress, run);
  }
  if (checkpoint.import_mode === 'text' && checkpoint.text_content !== '') {
    return resumeText(host, sessionId, checkpoint, progress, run);
  }
  const pages = rebuildPagesFromCheckpoint(checkpoint);
  return runVisualPipelineFromStage2(host, sessionId, checkpoint.qbank_name, pages, checkpoint,
    checkpoint.vlm_pages_completed, progress, run);
}

/** `{:?}` of `ImportStage`（Rust Debug 为变体名 PascalCase）。 */
function stageDebug(stage: ImportStage): string {
  return stage.split('_').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

/** DocxVlmDirectDone：VLM 已完成，直接收尾（question_import_service.rs:851-890）。 */
function resumeDocxVlmDirectDone(host: ImportServiceHost, sessionId: string, checkpoint: ImportCheckpointState,
  progress: ProgressSink): ImportResult {
  const saved = checkpoint.docx_vlm_direct_saved;
  const name = checkpoint.qbank_name;
  rebuildPreviewFromQuestions(host, sessionId);
  finalize(host, sessionId);
  send(progress, {
    type: 'Completed', session_id: sessionId, name, total_questions: saved, partial: false, failed_count: 0,
  });
  return committedResult(sessionId, name, saved);
}

/** 纯文本路径恢复（question_import_service.rs:1023-1182）。 */
async function resumeText(host: LegacyResumeHost, sessionId: string, checkpoint: ImportCheckpointState,
  progress: ProgressSink, run: ImportRun): Promise<ImportResult> {
  host.log?.info?.(`[QuestionImport] 恢复纯文本导入: session=${sessionId}, chunks=${checkpoint.chunks_completed}/${checkpoint.chunks_total}`);
  const text = checkpoint.text_content;
  const name = checkpoint.qbank_name;
  const maxTokensPerChunk = 6000;
  const estimatedTokens = Math.floor([...text].length / 2);
  const chunks = estimatedTokens <= maxTokensPerChunk ? [text] : segmentDocument(text, maxTokensPerChunk);
  const totalChunks = chunks.length;
  const chunksStart = checkpoint.chunks_completed;
  send(progress, { type: 'SessionCreated', session_id: sessionId, name, total_chunks: totalChunks });

  // 从已有题目数恢复 total_parsed（`.map(|r| r.total).unwrap_or(0)`）。
  let totalParsed = 0;
  try {
    totalParsed = host.questions.listQuestions(host.db, sessionId, {}, 1, 1).total;
  } catch { // boundary-allow empty-catch: question_import_service.rs:1069 `.unwrap_or(0)`，Rust 无日志
    totalParsed = 0;
  }
  let totalSaveFailed = 0;
  let firstFailure: string | null = null;

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    if (chunkIndex < chunksStart) continue;
    send(progress, { type: 'ChunkStart', chunk_index: chunkIndex, total_chunks: totalChunks });
    const prompt = buildTextParsePrompt(chunks[chunkIndex]!);
    let questionsInChunk = 0;
    try {
      await run.step(host.questionParsing.parseStreaming(prompt, checkpoint.model_config_id, question => {
        // 回调在取消后不再产生副作用（future 已被 drop）。
        if (run.cancelled) return false;
        const content = getStr(question, 'content') ?? '';
        if (rustTrim(content) === '') return true;
        const cardId = `card_${nanoid(12)}`;
        const params = jsonToQuestionParams(question, sessionId, cardId, totalParsed);
        try {
          host.questions.createQuestion(host.db, params);
        } catch (error) {
          host.log?.warn(`[QuestionImport] 保存题目失败: ${error instanceof Error ? error.message : String(error)}`);
          totalSaveFailed += 1;
          return true;
        }
        totalParsed += 1;
        questionsInChunk += 1;
        send(progress, { type: 'QuestionParsed', question, question_index: totalParsed - 1, total_parsed: totalParsed });
        return true;
      }));
    } catch (error) {
      if (run.cancelled) throw error;
      const message = toAppError(error).message;
      host.log?.warn(`[QuestionImport] 块 ${chunkIndex + 1} 解析失败: ${message}`);
      firstFailure ??= message;
    }
    checkpoint.chunks_completed = chunkIndex + 1;
    saveCheckpoint(host, sessionId, checkpoint);
    send(progress, {
      type: 'ChunkCompleted', chunk_index: chunkIndex, total_chunks: totalChunks,
      questions_in_chunk: questionsInChunk, total_parsed: totalParsed,
    });
  }

  if (totalParsed === 0) {
    try {
      host.exams.updateStatus(host.db, sessionId, 'completed');
    } catch { // boundary-allow empty-catch: question_import_service.rs:1146 `let _ = update_status`，Rust 无日志
    }
    try {
      host.exams.clearImportState(host.db, sessionId);
    } catch { // boundary-allow empty-catch: question_import_service.rs:1147 `let _ = clear_import_state`，Rust 无日志
    }
    if (totalSaveFailed > 0) {
      throw new QbankServiceError(AppError.database(`解析到 ${totalSaveFailed} 道题目但全部写入失败`));
    }
    throw new QbankServiceError(AppError.validation(noQuestionsError('未能提取到题目', firstFailure)));
  }

  rebuildPreviewFromQuestions(host, sessionId);
  finalize(host, sessionId);
  send(progress, {
    type: 'Completed', session_id: sessionId, name, total_questions: totalParsed,
    partial: totalSaveFailed > 0, failed_count: totalSaveFailed,
  });
  return committedResult(sessionId, name, totalParsed);
}
