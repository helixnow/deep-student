/**
 * `dstu-vision/src/llm_structurer.rs::LlmStructurer::structure_questions` — Stage 5:
 * VLM raw_text → 标准题目 JSON（每批 8 题，按 `_source_label` 对齐，失败批次记哨兵）。
 * LLM 调用 = L02 `llmQuestionParsing.parse`（Rust `call_llm_for_question_parsing_with_model`）。
 */
import type { JsonValue } from '../../../platform/errors/api.ts';
import type { JsonNode } from '../../../platform/util/portable.ts';
import { DIFFICULTY_RUBRIC } from './prompt-contracts.ts';
import { LATEX_OUTPUT_BRIEF } from '../../llm-providers/api.ts';
import type { QuestionWithFigures, StructuredQuestion } from '../api.ts';
import { BATCH_FAILED_SENTINEL, BATCH_SIZE } from './llm-structurer.ts';
import { parseJsonNode, serializeJsonNode, valueFromNode } from './vlm-serde.ts';

export type { StructuredQuestion };

export interface LlmStructurerDeps {
  /** `call_llm_for_question_parsing_with_model(prompt, model_config_id)`. */
  parse(prompt: string, modelConfigId: string | null): Promise<string>;
  sleep(ms: number): Promise<void>;
  log: { info(message: string): void; warn(message: string): void };
}

const errorText = (error: unknown): string => {
  if (error !== null && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message);
  return String(error);
};

/** Rust `{:?}` of `Option<&AppError>`, used only in the retry warning. */
const debugError = (error: unknown): string => {
  if (error !== null && typeof error === 'object' && 'error_type' in error) {
    const e = error as { error_type: unknown; message: unknown; details: unknown };
    return `Some(AppError { error_type: ${String(e.error_type)}, message: ${JSON.stringify(String(e.message))}, details: ${e.details === undefined || e.details === null ? 'None' : `Some(${JSON.stringify(e.details)})`} })`;
  }
  return `Some(${errorText(error)})`;
};

/** `parse_reusable_batch_result`（保留 `Value` 的整数/浮点区分用于再序列化）。 */
function reusableNodes(text: string): JsonNode[] | null {
  if (text === '' || text === BATCH_FAILED_SENTINEL) return null;
  const node = parseJsonNode(text);
  return node !== null && node.kind === 'array' && node.items.length > 0 ? [...node.items] : null;
}

/** `raw_text_to_minimal_json`. */
export function rawTextToMinimalJson(rawText: string, label: string): JsonValue {
  return {
    content: rawText, question_type: 'other', options: null, answer: null, explanation: null,
    difficulty: 'medium', tags: [], _source_label: label,
  };
}

function sourceLabel(value: JsonValue): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const label = value._source_label;
  return typeof label === 'string' ? label : null;
}

/** Rust `str::trim` (Unicode White_Space). */
const trim = (s: string): string => s.replace(/^[\p{White_Space}]+|[\p{White_Space}]+$/gu, '');

/** `align_by_label`：返回与 batch 等长的匹配结果。 */
export function alignByLabel(batch: readonly QuestionWithFigures[], parsed: readonly JsonValue[]): Array<JsonValue | undefined> {
  // `undefined` = Rust `None`; a matched JSON `null` stays `Some(Value::Null)`.
  const result: Array<JsonValue | undefined> = batch.map(() => undefined);
  const used = parsed.map(() => false);
  const hasLabels = parsed.some(p => sourceLabel(p) !== null);

  if (!hasLabels && parsed.length === batch.length) {
    parsed.forEach((p, i) => { result[i] = p; });
    return result;
  }

  parsed.forEach((p, pIdx) => {
    const pLabel = trim(sourceLabel(p) ?? '');
    if (pLabel === '') return;
    for (let i = 0; i < batch.length; i += 1) {
      if (result[i] !== undefined) continue;
      if (trim(batch[i]!.merged.question.label) === pLabel) {
        result[i] = p;
        used[pIdx] = true;
        break;
      }
    }
  });

  if (parsed.length === batch.length) {
    let nextUnused = 0;
    for (let i = 0; i < result.length; i += 1) {
      if (result[i] !== undefined) continue;
      while (nextUnused < parsed.length && used[nextUnused]) nextUnused += 1;
      if (nextUnused >= parsed.length) break;
      result[i] = parsed[nextUnused]!;
      used[nextUnused] = true;
      nextUnused += 1;
    }
  }
  return result;
}

/** `build_batch_prompt`. */
export function buildBatchPrompt(batch: readonly QuestionWithFigures[]): string {
  let questionsText = '';
  batch.forEach((qwf, i) => {
    questionsText += `--- 题目 ${i + 1} (label="${qwf.merged.question.label}") ---\n${qwf.merged.question.raw_text}\n\n`;
  });
  return `请将以下 ${batch.length} 道题目的原始文本结构化为标准 JSON 格式。不需要处理图片。

${questionsText}
**输出要求**：
输出一个 JSON 数组，每个元素对应一道题目（只输出 JSON，不要其他内容）：

\`\`\`json
[
  {
    "_source_label": "1",
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
1. \`_source_label\` 必须填写原始题号标签（括号中 label= 的值），用于对齐
2. 选择题必须将选项拆分到 options 数组，content 只保留题干
3. 题型: single_choice=单选, multiple_choice=多选, fill_blank=填空, short_answer=简答
4. 公式格式：${LATEX_OUTPUT_BRIEF}
5. 没有答案/解析的字段输出 null
6. difficulty 按下方判定标准逐题判断
7. 输出数组长度必须等于输入题目数量 (${batch.length})

${DIFFICULTY_RUBRIC}`;
}

/** `parse_llm_response`：截取首个 `[` 到最后一个 `]`，解析失败返回空。 */
function parseLlmResponse(response: string, log: LlmStructurerDeps['log']): JsonNode[] {
  let jsonStr = response;
  const start = response.indexOf('[');
  if (start >= 0) {
    const end = response.lastIndexOf(']');
    if (end >= 0) jsonStr = response.slice(start, end + 1);
  }
  const node = parseJsonNode(jsonStr);
  if (node === null || node.kind !== 'array') {
    log.warn('[LlmStructurer] 解析 LLM 响应失败: ' + (node === null ? 'invalid JSON' : 'invalid type: expected a sequence'));
    return [];
  }
  return [...node.items];
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * `structure_questions` → `[已完成批次数（成功前缀长度）, 各批结果 JSON, 结构化题目]`。
 * 失败批次持久化 `__LLM_BATCH_FAILED__` 且不推进 completed，恢复时会重试。
 */
export async function structureQuestions(
  questions: readonly QuestionWithFigures[],
  modelConfigId: string | null,
  batchesCompleted: number,
  priorBatchResults: readonly string[],
  deps: LlmStructurerDeps,
): Promise<[number, string[], StructuredQuestion[]]> {
  if (questions.length === 0) return [0, [], []];

  const total = questions.length;
  const results: StructuredQuestion[] = [];
  const batchResultJsons = [...priorBatchResults];
  const allBatches = chunks(questions, BATCH_SIZE);
  const totalBatches = allBatches.length;

  deps.log.info(`[LlmStructurer] 开始结构化 ${total} 道题目 (${totalBatches} 批, 跳过前 ${batchesCompleted} 批)`);

  const pushAligned = (batch: readonly QuestionWithFigures[], parsed: readonly JsonValue[]): void => {
    const matched = alignByLabel(batch, parsed);
    batch.forEach((qwf, i) => {
      results.push({
        json: matched[i] !== undefined ? matched[i]! : rawTextToMinimalJson(qwf.merged.question.raw_text, qwf.merged.question.label),
        source: qwf,
      });
    });
  };

  for (let batchIdx = 0; batchIdx < Math.min(batchesCompleted, totalBatches); batchIdx += 1) {
    const batch = allBatches[batchIdx]!;
    const prior = priorBatchResults[batchIdx];
    const restored = (prior === undefined ? null : reusableNodes(prior)) ?? [];
    if (restored.length === 0) {
      for (const qwf of batch) {
        results.push({ json: rawTextToMinimalJson(qwf.merged.question.raw_text, qwf.merged.question.label), source: qwf });
      }
    } else {
      pushAligned(batch, restored.map(valueFromNode));
    }
  }

  let completed = batchesCompleted;
  let prefixAllOk = true;

  for (let batchIdx = batchesCompleted; batchIdx < totalBatches; batchIdx += 1) {
    const batch = allBatches[batchIdx]!;

    const prior = priorBatchResults[batchIdx];
    const priorParsed = prior === undefined ? null : reusableNodes(prior);
    if (priorParsed !== null) {
      deps.log.info(`[LlmStructurer] 批次 ${batchIdx + 1}/${totalBatches}: 复用已持久化的成功结果（${priorParsed.length} 项）`);
      pushAligned(batch, priorParsed.map(valueFromNode));
      if (prefixAllOk) completed = batchIdx + 1;
      continue;
    }

    const prompt = buildBatchPrompt(batch);
    const call = async (): Promise<{ ok: true; response: string } | { ok: false; error: unknown }> => {
      try { return { ok: true, response: await deps.parse(prompt, modelConfigId) }; }
      catch (error) { return { ok: false, error }; }
    };
    let callResult = await call();
    if (!callResult.ok) {
      deps.log.warn(`[LlmStructurer] 批次 ${batchIdx + 1}/${totalBatches} LLM 调用失败，2s 后重试一次: ${debugError(callResult.error)}`);
      await deps.sleep(2_000);
      callResult = await call();
    }

    let batchJsonStr: string;
    let parsed: JsonNode[];
    let batchOk: boolean;
    if (callResult.ok) {
      parsed = parseLlmResponse(callResult.response, deps.log);
      if (parsed.length === 0) {
        deps.log.warn(`[LlmStructurer] 批次 ${batchIdx + 1}/${totalBatches} LLM 返回无法解析出题目，记为失败（可重试）`);
        batchJsonStr = BATCH_FAILED_SENTINEL;
        batchOk = false;
      } else {
        batchJsonStr = serializeJsonNode({ kind: 'array', items: parsed });
        batchOk = true;
      }
    } else {
      deps.log.warn(`[LlmStructurer] 批次 ${batchIdx + 1}/${totalBatches} LLM 调用失败: ${errorText(callResult.error)}, 本轮回退为 minimal JSON（checkpoint 不标记完成，恢复时重试）`);
      batchJsonStr = BATCH_FAILED_SENTINEL;
      parsed = [];
      batchOk = false;
    }

    const parsedValues = parsed.map(valueFromNode);
    const matched = alignByLabel(batch, parsedValues);
    deps.log.info(`[LlmStructurer] 批次 ${batchIdx + 1}/${totalBatches}: LLM 返回 ${parsed.length} 项, 匹配 ${matched.filter(m => m !== undefined).length} 项`);
    batch.forEach((qwf, i) => {
      results.push({
        json: matched[i] !== undefined ? matched[i]! : rawTextToMinimalJson(qwf.merged.question.raw_text, qwf.merged.question.label),
        source: qwf,
      });
    });

    while (batchResultJsons.length <= batchIdx) batchResultJsons.push('');
    batchResultJsons[batchIdx] = batchJsonStr;

    if (batchOk && prefixAllOk) completed = batchIdx + 1;
    else if (!batchOk) prefixAllOk = false;
  }

  deps.log.info(`[LlmStructurer] 结构化完成: ${results.length}/${total} 道题目`);
  return [completed, batchResultJsons, results];
}
