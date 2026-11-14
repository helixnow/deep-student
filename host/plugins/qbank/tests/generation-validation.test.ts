import { describe, expect, it } from 'vitest';
import type { GeneratedQuestionDraft, QbankGenerationRequest } from '../api.ts';
import { extractJsonArray, normalizeEscapedText, parseGenerationOutput, validateDraft, validateSmiles } from '../src/generation-validation.ts';
import { buildGenerationInstructions } from '../src/generation-prompt.ts';

function draft(question_type: string, content: string, options: [string, string][] | null, answer: string): GeneratedQuestionDraft {
  return { question_type, content, options: options?.map(([key, content]) => ({ key, content })) ?? null,
    answer, explanation: null, difficulty: 'medium', tags: null, smiles: null, smiles_caption: null };
}

describe('qbank_generation/types.rs validation', () => {
  it('validate_smiles_accepts_common_molecules_and_rejects_bad_input', () => {
    expect(() => validateSmiles('CCO')).not.toThrow();
    expect(() => validateSmiles('c1ccccc1')).not.toThrow();
    expect(() => validateSmiles('CC(=O)O')).not.toThrow();
    expect(() => validateSmiles('C[C@H](N)C(=O)O')).not.toThrow();
    expect(() => validateSmiles('CC(=O')).toThrow();
    // Rust's ring-number assertion is tautological; its implementation accepts this input.
    expect(() => validateSmiles('c1ccccc')).not.toThrow();
    expect(() => validateSmiles('CC O<H>')).toThrow();
  });
  it('validate_draft_checks_smiles_pair_consistency', () => {
    const good = draft('single_choice', '下列哪个是乙醇？', [['A', '甲醇'], ['B', '乙醇']], 'B');
    good.smiles = 'CCO'; good.smiles_caption = '乙醇';
    expect(() => validateDraft(good)).not.toThrow();
    const captionOnly = draft('single_choice', '题干', [['A', 'x'], ['B', 'y']], 'A');
    captionOnly.smiles_caption = '苯';
    expect(() => validateDraft(captionOnly)).toThrow();
    const bad = draft('single_choice', '题干', [['A', 'x'], ['B', 'y']], 'A');
    bad.smiles = 'CC(=O';
    expect(() => validateDraft(bad)).toThrow();
  });
  it('extract_json_array_handles_fenced_and_noisy_output', () => {
    expect(extractJsonArray('[{"a":1}]')).toBe('[{"a":1}]');
    expect(extractJsonArray('```json\n[{"a":1}]\n```')).toBe('[{"a":1}]');
    expect(extractJsonArray('好的，以下是题目：\n[{"a":1}]\n希望有帮助')).toBe('[{"a":1}]');
    expect(extractJsonArray('没有数组')).toBeNull();
  });
  it('validate_draft_accepts_valid_single_choice_and_rejects_bad_answer_key', () => {
    expect(() => validateDraft(draft('single_choice', '1+1=?', [['A', '2'], ['B', '3']], 'A'))).not.toThrow();
    expect(() => validateDraft(draft('single_choice', '1+1=?', [['A', '2'], ['B', '3']], 'C'))).toThrow();
    expect(() => validateDraft(draft('single_choice', '1+1=?', [['A', '2'], ['B', '3']], 'AB'))).toThrow();
  });
  it('validate_draft_rejects_empty_options_and_true_false_bad_value', () => {
    expect(() => validateDraft(draft('single_choice', '1+1=?', null, 'A'))).toThrow();
    expect(() => validateDraft(draft('true_false', '1+1=2', null, 'yes'))).toThrow();
    expect(() => validateDraft(draft('true_false', '1+1=2', null, 'TRUE'))).not.toThrow();
  });
  it('validate_draft_rejects_unsupported_types', () => {
    expect(() => validateDraft(draft('matching', '连线', null, '1-A'))).toThrow();
  });
  it('parse_generation_output_filters_invalid_items_and_reports_reasons', () => {
    const raw = `[
      {"question_type":"single_choice","content":"1+1=?","options":[{"key":"A","content":"2"},{"key":"B","content":"3"}],"answer":"A"},
      {"question_type":"short_answer","content":"","answer":"x"},
      {"question_type":"true_false","content":"1+1=2","answer":"true"}
    ]`;
    const response = parseGenerationOutput(raw, 10);
    expect(response.drafts).toHaveLength(2);
    expect(response.drafts[0]?.question_type).toBe('single_choice');
    expect(response.drafts[1]?.question_type).toBe('true_false');
    expect(response.rejected_count).toBe(1);
    expect(response.rejection_reasons[0]).toContain('第 2 题');
  });
  it('parse_generation_output_truncates_to_max_questions', () => {
    const raw = `[
      {"question_type":"true_false","content":"1=1","answer":"true"},
      {"question_type":"true_false","content":"2=2","answer":"true"},
      {"question_type":"true_false","content":"3=3","answer":"true"}
    ]`;
    const response = parseGenerationOutput(raw, 2);
    expect(response.drafts).toHaveLength(2);
    expect(response.rejected_count).toBe(1);
    expect(response.rejection_reasons[0]).toContain('上限');
  });
  it('parse_generation_output_rejects_empty_and_non_json', () => {
    expect(() => parseGenerationOutput('随便说说', 10)).toThrow();
    expect(() => parseGenerationOutput('[]', 10)).toThrow();
  });
  it('normalize_escaped_text_restores_literal_newlines', () => {
    expect(normalizeEscapedText('Read the sentence:\\n\\n> quote')).toBe('Read the sentence:\n\n> quote');
    expect(normalizeEscapedText('a\\t b')).toBe('a\t b');
    expect(normalizeEscapedText('第一行\\n第二行')).toBe('第一行\n第二行');
    expect(normalizeEscapedText('a\\r\\nb')).toBe('a\nb');
  });
  it('normalize_escaped_text_keeps_latex_commands', () => {
    for (const text of ['$\\nu$', '$a \\neq b$', '$\\nabla f$', '$\\textbf{x}$']) expect(normalizeEscapedText(text)).toBe(text);
  });
  it('parse_generation_output_restores_double_escaped_fields', () => {
    const raw = `[{"question_type":"single_choice","content":"第一行\\\\n\\\\n第二行","options":[{"key":"A","content":"选项\\\\n说明"},{"key":"B","content":"普通"}],"answer":"A","explanation":"解析\\\\n结束","difficulty":"medium","tags":["t"]}]`;
    const response = parseGenerationOutput(raw, 5);
    expect(response.drafts).toHaveLength(1);
    const parsed = response.drafts[0]!;
    expect(parsed.content).toBe('第一行\n\n第二行');
    expect(parsed.explanation).toBe('解析\n结束');
    expect(parsed.options![0]!.content).toBe('选项\n说明');
    expect(parsed.options![1]!.content).toBe('普通');
  });
  it('build_generation_user_prompt_includes_specs_and_hint', () => {
    const request: QbankGenerationRequest = {
      exam_id: 'exam_1', stream_session_id: 'sess', model_config_id: null, max_questions: 5,
      specs: [{ question_type: 'single_choice', count: 3, difficulty: 'hard' }], difficulty: null,
      topic_hint: '二次函数', based_on_existing: false, language: 'zh-CN',
      reference_file_ids: [], reference_files_base64: [], knowledge_points: [],
    };
    const prompt = buildGenerationInstructions('测试题目集', [], request, [], false);
    expect(prompt).toContain('「测试题目集」');
    expect(prompt).toContain('single_choice: 3 题');
    expect(prompt).toContain('二次函数');
    expect(prompt).toContain('zh-CN');
  });
  it('build_generation_user_prompt_includes_knowledge_points_and_references', () => {
    const request: QbankGenerationRequest = {
      exam_id: 'exam_1', stream_session_id: 'sess', model_config_id: null, max_questions: 5,
      specs: [], difficulty: null, topic_hint: null, based_on_existing: false, language: 'zh-CN',
      reference_file_ids: ['file_1'], reference_files_base64: [],
      knowledge_points: ['二次函数', '  ', '因式分解'],
    };
    const references = [{ source_id: 's1', name: '课本第2章.pdf', page_count: 2 }];
    const prompt = buildGenerationInstructions('测试题目集', [], request, references, false);
    expect(prompt).toContain('## 知识点范围（围绕这些知识点出题）');
    expect(prompt).toContain('- 二次函数');
    expect(prompt).not.toContain('-  ');
    expect(prompt).toContain('课本第2章.pdf');
  });
  it('build_generation_user_prompt_adds_media_source_rules_only_for_transcripts', () => {
    const request: QbankGenerationRequest = {
      exam_id: 'exam_1', stream_session_id: 'sess', model_config_id: null, max_questions: 3,
      specs: [], difficulty: null, topic_hint: null, based_on_existing: false, language: 'zh-CN',
      reference_file_ids: ['file_lecture'], reference_files_base64: [], knowledge_points: [],
    };
    const prompt = buildGenerationInstructions('物理', [], request, [], true);
    expect(prompt).toContain('## 音视频课程出处要求');
    expect(prompt).toContain('[媒体@资源ID:mm:ss]');
    expect(buildGenerationInstructions('物理', [], request, [], false)).not.toContain('音视频课程出处要求');
  });
  it('generation_instructions_preserve_long_user_requirements', () => {
    const request: QbankGenerationRequest = {
      exam_id: 'exam_1', stream_session_id: 'sess', model_config_id: null, max_questions: 5,
      specs: [], difficulty: null, topic_hint: 'long user requirement '.repeat(5000), based_on_existing: false,
      language: null, reference_file_ids: [], reference_files_base64: [], knowledge_points: [],
    };
    const prompt = buildGenerationInstructions('测试', [], request, [], false);
    expect(prompt).toContain(request.topic_hint!.trim());
    expect(prompt).not.toContain('已截断');
  });
  it('build_generation_user_prompt_includes_reference_images_section', () => {
    const request: QbankGenerationRequest = {
      exam_id: 'exam_1', stream_session_id: 'sess', model_config_id: null, max_questions: 5,
      specs: [], difficulty: null, topic_hint: null, based_on_existing: false, language: 'zh-CN',
      reference_file_ids: [], reference_files_base64: [], knowledge_points: [],
    };
    const prompt = buildGenerationInstructions('测试', [], request, [{ source_id: 's1', name: '单词表.pdf', page_count: 20 }], false);
    expect(prompt).toContain('单词表.pdf');
    expect(prompt).toContain('20');
  });
  it('keeps the original SMILES character whitelist, byte limit, and error messages', () => {
    expect(() => validateSmiles('CCl')).toThrow("SMILES 含非法字符 'l'：CCl");
    expect(() => validateSmiles('碳'.repeat(86))).toThrow('SMILES 过长（258 字符）');
    expect(() => validateSmiles(')(')).toThrow('SMILES 括号不配对: )(');
  });
});
