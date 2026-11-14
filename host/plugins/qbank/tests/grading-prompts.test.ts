import { describe, expect, it } from 'vitest';
import type { AnswerSubmission, Question, QuestionMaterial } from '../api.ts';
import { GradingContext, type GradingImage } from '../src/grading-context.ts';
import {
  ANALYZE_SYSTEM_PROMPT, EXPLANATION_SYSTEM_PROMPT, buildPrompts, parseVerdictAndScore,
} from '../src/grading-prompts.ts';
import { parseImageAnswerEnvelope } from '../src/image-answer.ts';

function question(): Question {
  return {
    id: 'q1', exam_id: 'e1', card_id: null, question_label: '1', content: '简述牛顿第二定律',
    options: null, answer: 'F = ma', explanation: null, structured_data: null,
    question_type: 'short_answer', difficulty: null, tags: [], status: 'new',
    user_answer: null, is_correct: null, attempt_count: 0, correct_count: 0,
    last_attempt_at: null, user_note: null, is_favorite: false, is_bookmarked: false,
    source_type: 'manual', source_ref: null, images: [], parent_id: null,
    created_at: '', updated_at: '', ai_feedback: null, ai_score: null, ai_graded_at: null,
    group_id: null, group_position: null, group_label: null, materials: [],
    answer_origin: null, source_refs: [], answer_source_refs: [], source_key: null,
  };
}

function submission(answer: string): AnswerSubmission {
  return {
    id: 'sub1', question_id: 'q1', user_answer: answer, is_correct: null,
    grading_method: 'ai', submitted_at: '2026-09-26T00:00:00Z',
  };
}

function envelopeRaw(): string {
  return JSON.stringify({
    type: 'image_answer',
    images: [
      { id: 'att1', name: 'a.jpg', mime: 'image/jpeg', hash: 'h1' },
      { id: 'att2', name: 'b.jpg', mime: 'image/jpeg', hash: 'h2' },
    ],
    text: '第二问没把握',
  });
}

function material(content: string, version: number): QuestionMaterial {
  return {
    id: 'm1', content, images: [], source_refs: [], version,
  };
}

describe('qbank_grading/pipeline.rs prompts', () => {
  it('build_prompts_uses_placeholder_for_image_envelope', () => {
    const q = question();
    const current = submission(envelopeRaw());
    const payload = parseImageAnswerEnvelope(envelopeRaw())!;

    const { userPrompt } = buildPrompts(
      q, GradingContext.fromQuestion(q), current, [], 'grade', payload);

    expect(userPrompt).toContain('共 2 张');
    expect(userPrompt).toContain('学生文字补充：第二问没把握');
    expect(userPrompt).not.toContain('image_answer');
    expect(userPrompt).not.toContain('att1');
  });

  it('build_prompts_keeps_raw_text_answer_untouched', () => {
    const q = question();
    const current = submission('物体所受合力等于质量与加速度的乘积');

    const { userPrompt } = buildPrompts(
      q, GradingContext.fromQuestion(q), current, [], 'grade', null);

    expect(userPrompt).toContain('物体所受合力等于质量与加速度的乘积');
  });

  it('build_prompts_includes_structured_data_when_present', () => {
    const q = question();
    q.question_type = 'fill_blank';
    q.structured_data = {
      blanks: [
        { answers: ['牛顿第二定律', "Newton's second law"], case_sensitive: false, trim: true },
      ],
    };
    const current = submission('牛顿定律');

    const { userPrompt } = buildPrompts(
      q, GradingContext.fromQuestion(q), current, [], 'grade', null);

    expect(userPrompt).toContain('## 结构化作答要求');
    expect(userPrompt).toContain('牛顿第二定律');
    expect(userPrompt).toContain("Newton's second law");
  });

  it('build_prompts_omits_structured_data_section_when_null_or_empty', () => {
    for (const structured of [null, {}, undefined]) {
      const q = question();
      q.structured_data = structured;
      const current = submission('文字作答');

      const { userPrompt } = buildPrompts(
        q, GradingContext.fromQuestion(q), current, [], 'grade', null);

      expect(userPrompt).not.toContain('## 结构化作答要求');
    }
  });

  it('build_prompts_includes_shared_material_and_figure_manifest', () => {
    const q = question();
    const context = GradingContext.fromQuestion(q);
    context.materials.push({
      ...material('阅读下面的文章，回答第 1 题。', 2),
      images: [{ id: 'att_fig', name: 'fig.png', mime: 'image/png', hash: 'h1', role: null }],
    });
    const image: GradingImage = {
      base64: 'AAA', mime: 'image/png', label: '材料「阅读下面的文章，回答第 1 题。」配图',
    };
    context.images.push(image);

    const { userPrompt } = buildPrompts(q, context, null, [], 'analyze', null);

    expect(userPrompt).toContain('## 共享材料');
    expect(userPrompt).toContain('阅读下面的文章');
    expect(userPrompt).toContain('version: 2');
    expect(userPrompt).toContain('## 附图清单');
    expect(userPrompt).toContain('图1：材料「阅读下面的文章');
  });

  it('build_prompts_renders_history_envelopes_as_count_marker', () => {
    const q = question();
    const current = submission('新的文字作答');
    const historyText = submission('旧的文字作答');
    const historyEnvelope: AnswerSubmission = { ...submission(envelopeRaw()), id: 'sub0' };

    const { userPrompt } = buildPrompts(
      q, GradingContext.fromQuestion(q), current, [historyEnvelope, historyText], 'grade', null);

    expect(userPrompt).toContain('[图片作答 2 张]');
    expect(userPrompt).not.toContain('"type":"image_answer"');
    expect(userPrompt).toContain('旧的文字作答');
  });

  it('build_prompts_without_submission_uses_explanation_prompt', () => {
    const q = question();
    const history = submission('旧的文字作答');

    const { systemPrompt, userPrompt } = buildPrompts(
      q, GradingContext.fromQuestion(q), null, [history], 'analyze', null);

    expect(systemPrompt.startsWith(EXPLANATION_SYSTEM_PROMPT)).toBe(true);
    expect(userPrompt).toContain('简述牛顿第二定律');
    expect(userPrompt).toContain('## 参考答案\nF = ma');
    expect(userPrompt).not.toContain('学生答案');
    expect(userPrompt).not.toContain('历次作答');
    expect(userPrompt).not.toContain('旧的文字作答');
  });

  it('build_prompts_analyze_with_submission_keeps_student_prompt', () => {
    const q = question();
    const current: AnswerSubmission = { ...submission('F = mv'), is_correct: false };

    const { systemPrompt, userPrompt } = buildPrompts(
      q, GradingContext.fromQuestion(q), current, [], 'analyze', null);

    expect(systemPrompt.startsWith(ANALYZE_SYSTEM_PROMPT)).toBe(true);
    expect(userPrompt).toContain('## 学生答案（错误）\nF = mv');
  });
});

describe('qbank_grading/pipeline.rs verdict parser', () => {
  it('verdict_parser_accepts_explicit_case_and_attribute_spacing_variants', () => {
    const { verdict, score } = parseVerdictAndScore(
      "Feedback\n<VERDICT > PARTIAL </VERDICT >\n<SCORE value = '72' />");
    expect(verdict).toBe('partial');
    expect(score).toBe(72);
  });

  it('verdict_parser_does_not_infer_a_grade_from_prose_or_scores', () => {
    expect(parseVerdictAndScore('The answer is correct. 90/100.'))
      .toEqual({ verdict: null, score: null });
    expect(parseVerdictAndScore('<score value="90"/>'))
      .toEqual({ verdict: null, score: 90 });
  });

  it('test_parse_verdict_and_score', () => {
    expect(parseVerdictAndScore(
      '分析过程…… <verdict>partial</verdict> <score value="65"/>'))
      .toEqual({ verdict: 'partial', score: 65 });

    expect(parseVerdictAndScore('没有任何标签的纯文本'))
      .toEqual({ verdict: null, score: null });
  });

  it('test_parse_verdict_and_score_takes_last_match', () => {
    const text = '输出格式为 <verdict>correct</verdict> <score value="100"/>。\n'
      + '经过对比，学生答案部分正确。\n'
      + '<verdict>partial</verdict>\n<score value="55"/>';
    expect(parseVerdictAndScore(text)).toEqual({ verdict: 'partial', score: 55 });
  });

  it('test_parse_verdict_and_score_clamps_range', () => {
    expect(parseVerdictAndScore('<verdict>correct</verdict> <score value="150"/>').score)
      .toBe(100);
  });
});
