/**
 * 判分 prompt 构造与结构化输出解析（qbank_grading/pipeline.rs:795-1070）。
 *
 * 提示词、共享材料、附图清单、题型/选项/结构化要求、当前作答与历次作答顺序
 * 都与 Rust 逐字一致；verdict/score 取最后一个匹配，符合"末尾标签为准"。
 */
import type { AnswerSubmission, Verdict } from '../api.ts';
import { parseImageAnswerEnvelope, type ImageAnswerPayload } from './image-answer.ts';
import type { GradingContext, GradingImage } from './grading-context.ts';

export type GradingMode = 'grade' | 'analyze';

export interface BuiltPrompts {
  systemPrompt: string;
  userPrompt: string;
}

export interface VerdictAndScore {
  verdict: Verdict | null;
  score: number | null;
}

/** Grade 模式的系统提示词（主观题评判）。 */
export const GRADE_SYSTEM_PROMPT = `你是一位严谨的教师，负责批改学生的主观题作答。请根据参考答案评判学生答案的正确性，给出评分和详细反馈。

## 评判要求
1. 仔细对比学生答案与参考答案的要点
2. 考虑答案的完整性、准确性和表达清晰度
3. 给出具体的改进建议

## 图片作答
若学生以手写图片作答：请先在反馈开头逐条誊写你从图片中识别出的内容（便于学生核对识别是否准确），再对照参考答案评判。

## 输出格式要求
在反馈的最末尾，必须输出以下两个标签（整个回复中只能各出现一次）：
<verdict>correct|partial|incorrect</verdict>
<score value="0-100"/>

- correct: 答案正确或基本正确（得分 >= 80）
- partial: 答案部分正确（得分 40-79）
- incorrect: 答案错误或严重不完整（得分 < 40）

主体部分请用 Markdown 格式撰写详细的评判与解析。
公式格式遵循统一的 LaTeX 公式契约（见 prompt 末尾）。`;

/** Analyze 模式的系统提示词（客观题解析）。 */
export const ANALYZE_SYSTEM_PROMPT = `你是一位善于启发学生的教师。请针对学生的作答情况，提供详细的解题思路分析和知识点讲解。

## 分析要求
请用 Markdown 格式从以下几个方面进行分析：
1. **解题思路**：详细的解题过程和方法
2. **知识点**：涉及的核心知识点和公式
3. **易错点**：常见的错误和注意事项
4. **学习建议**：针对性的学习方向建议

若学生以手写图片作答：请先简要说明你从图片中识别出的作答内容，再展开分析。

公式格式遵循统一的 LaTeX 公式契约（见 prompt 末尾）。
请不要输出 <verdict> 或 <score> 标签。`;

/** 通用解析模式的系统提示词（无作答记录：为题目本身撰写解析）。 */
export const EXPLANATION_SYSTEM_PROMPT = `你是一位善于讲解的教师。请为下面这道题撰写一份解析，它会作为题目自带的「解析」长期保存，供所有做这道题的学生参考。

## 撰写要求
请用 Markdown 格式，包含以下几部分：
1. **答案**：给出正确答案（有参考答案时以参考答案为准，不要另起炉灶）
2. **解题思路**：清晰的推理或计算过程
3. **知识点**：涉及的核心概念和公式
4. **易错点**：常见的错误和注意事项

不要假设或评价任何学生的作答，也不要写"你的答案"之类针对个人的话。
公式格式遵循统一的 LaTeX 公式契约（见 prompt 末尾）。
请不要输出 <verdict> 或 <score> 标签。`;

/** dstu-core/prompt_contracts.rs:50 的 LATEX_OUTPUT_BRIEF（单一来源按 Rust 文本复制）。 */
export const LATEX_OUTPUT_BRIEF = '数学/化学公式必须用 LaTeX 书写并以 $...$（行内）或 $$...$$（块级）包裹，'
  + '分隔符成对闭合；禁止裸写公式（如 10^5、\\frac），禁止使用 \\(...\\) 或 \\[...\\]，禁止用代码块包裹公式。';

/** 讲解语言跟随题目（pipeline.rs:793）。 */
export const QBANK_RESPONSE_LANGUAGE_RULE = 'Language: write your feedback in the same language as the question text '
  + '(an English question gets an English explanation, including section headings; a Chinese question gets Chinese). '
  + '讲解语言与题目语言一致。';

function systemPromptFor(mode: GradingMode, hasSubmission: boolean): string {
  const base = mode === 'grade'
    ? GRADE_SYSTEM_PROMPT
    : hasSubmission ? ANALYZE_SYSTEM_PROMPT : EXPLANATION_SYSTEM_PROMPT;
  return `${base}\n\n${LATEX_OUTPUT_BRIEF}\n\n${QBANK_RESPONSE_LANGUAGE_RULE}`;
}

function correctLabel(isCorrect: boolean | null): string {
  if (isCorrect === true) return '正确';
  if (isCorrect === false) return '错误';
  return '待评判';
}

/**
 * Rust `build_prompts`：返回 (system_prompt, user_prompt)。
 *
 * `question` 参数在 Rust 中不参与构造（保留用于签名对齐），这里同样忽略。
 */
export function buildPrompts(
  _question: unknown,
  context: GradingContext,
  currentSubmission: AnswerSubmission | null,
  submissions: readonly AnswerSubmission[],
  mode: GradingMode,
  imageAnswer: ImageAnswerPayload | null,
): BuiltPrompts {
  const systemPrompt = systemPromptFor(mode, currentSubmission !== null);

  let userPrompt = '';

  if (context.materials.length > 0) {
    userPrompt += '## 共享材料\n';
    context.materials.forEach((material, index) => {
      userPrompt += `### 材料 ${index + 1}（id: ${material.id}，version: ${material.version}）\n`;
      if (material.content.trim() === '') {
        userPrompt += '（该材料无可读文字，内容见配图）\n';
      } else {
        userPrompt += material.content;
        userPrompt += '\n';
      }
      if (material.images.length > 0) {
        userPrompt += `（该材料附带 ${material.images.length} 张配图，见附图清单与消息中的图片）\n`;
      }
      userPrompt += '\n';
    });
  }

  if (context.images.length > 0) {
    userPrompt += '## 附图清单\n';
    context.images.forEach((image: GradingImage, index: number) => {
      userPrompt += `- 图${index + 1}：${image.label}\n`;
    });
    userPrompt += '\n';
  }

  userPrompt += '## 题目\n';
  userPrompt += context.content;
  userPrompt += '\n\n';

  userPrompt += `## 题型\n${context.question_type}\n\n`;

  if (context.options !== null) {
    userPrompt += '## 选项\n';
    for (const option of context.options) {
      userPrompt += `${option.key}. ${option.content}\n`;
    }
    userPrompt += '\n';
  }

  // 填空空位定义 / 数值容差 / 匹配配对 / 排序正序：判分依据不止 answer。
  if (context.structured_data !== null && context.structured_data !== undefined
    && JSON.stringify(context.structured_data) !== '{}') {
    userPrompt += '## 结构化作答要求\n';
    userPrompt += JSON.stringify(context.structured_data, null, 2);
    userPrompt += '\n\n';
  }

  if (context.answer !== null) {
    userPrompt += '## 参考答案\n';
    userPrompt += context.answer;
    userPrompt += '\n\n';
  }

  if (context.explanation !== null) {
    userPrompt += '## 参考解析\n';
    userPrompt += context.explanation;
    userPrompt += '\n\n';
  }

  if (currentSubmission === null) return { systemPrompt, userPrompt };

  let label: string;
  if (mode === 'grade') {
    label = '## 学生答案（待评判）';
  } else if (currentSubmission.is_correct === true) {
    label = '## 学生答案（正确）';
  } else if (currentSubmission.is_correct === false) {
    label = '## 学生答案（错误）';
  } else {
    label = '## 学生答案（待评判）';
  }
  userPrompt += label;
  userPrompt += '\n';
  if (imageAnswer !== null) {
    const start = context.images.length + 1;
    const range = imageAnswer.images.length === 1
      ? `图${start}`
      : `图${start}–图${start + Math.max(imageAnswer.images.length - 1, 0)}`;
    userPrompt += `（学生以手写图片作答，共 ${imageAnswer.images.length} 张，对应${range}，请直接阅读图片内容评判）\n`;
    if (imageAnswer.text.trim() !== '') {
      userPrompt += `学生文字补充：${imageAnswer.text}\n`;
    }
  } else {
    userPrompt += currentSubmission.user_answer;
  }
  userPrompt += '\n\n';

  if (submissions.length > 0) {
    userPrompt += '## 历次作答记录\n';
    submissions.forEach((submission, index) => {
      const answer = parseImageAnswerEnvelope(submission.user_answer);
      const answerText = answer !== null
        ? `[图片作答 ${answer.images.length} 张]`
        : `"${submission.user_answer}"`;
      userPrompt += `第${index + 1}次：答案=${answerText}，结果=${correctLabel(submission.is_correct)}，`
        + `方式=${submission.grading_method}，时间=${submission.submitted_at}\n`;
    });
    userPrompt += '\n';
  }

  return { systemPrompt, userPrompt };
}

const VERDICT_PATTERN = /<verdict\s*>\s*(correct|partial|incorrect)\s*<\/verdict\s*>/gi;
const SCORE_PATTERN = /<score\s+value\s*=\s*["'](\d+)["']\s*\/>/gi;

/** Rust `parse_verdict_and_score`：取最后一个匹配；score 裁剪到 0-100。 */
export function parseVerdictAndScore(result: string): VerdictAndScore {
  let verdict: Verdict | null = null;
  for (const match of result.matchAll(VERDICT_PATTERN)) {
    verdict = (match[1] ?? '').toLowerCase() as Verdict;
  }

  let score: number | null = null;
  for (const match of result.matchAll(SCORE_PATTERN)) {
    const parsed = Number.parseInt(match[1] ?? '', 10);
    // Rust `parse::<i32>()`：超出 i32 的数字视为解析失败（None）。
    if (!Number.isSafeInteger(parsed) || parsed > 2_147_483_647) {
      score = null;
      continue;
    }
    score = Math.min(Math.max(parsed, 0), 100);
  }

  return { verdict, score };
}
