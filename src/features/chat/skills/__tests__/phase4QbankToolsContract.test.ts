import { describe, expect, it } from 'vitest';

import { qbankToolsSkill } from '../builtin-tools/qbank-tools';

const PHASE_FOUR_TOOLS = [
  'builtin-qbank_create_question',
  'builtin-qbank_delete_questions',
  'builtin-qbank_toggle_favorite',
  'builtin-qbank_start_timed_practice',
  'builtin-qbank_generate_mock_exam',
  'builtin-qbank_get_daily_practice',
  'builtin-qbank_get_check_in_calendar',
  'builtin-qbank_generate_paper',
  'builtin-qbank_search_questions',
  'builtin-qbank_get_learning_trend',
  'builtin-qbank_get_activity_heatmap',
  'builtin-qbank_get_knowledge_stats',
] as const;

function getTool(name: string) {
  const matches = qbankToolsSkill.embeddedTools?.filter((tool) => tool.name === name) ?? [];
  expect(matches, `${name} must have exactly one embedded schema`).toHaveLength(1);
  return matches[0]!;
}

// Shared rules are injected with the loaded skill, so contracts may be stated
// once there instead of repeated in every tool schema.
function instructionsFor(name: string): string {
  return `${getTool(name).description}\n${qbankToolsSkill.content}`;
}

describe('phase 4 qbank tool contracts', () => {
  it('keeps every allowed tool backed by one embedded schema', () => {
    const embeddedNames = qbankToolsSkill.embeddedTools?.map((tool) => tool.name) ?? [];

    expect(qbankToolsSkill.allowedTools).toEqual(embeddedNames);
    expect(new Set(embeddedNames).size).toBe(embeddedNames.length);
    expect(embeddedNames).toEqual(expect.arrayContaining(PHASE_FOUR_TOOLS));
  });

  it('caps all existing list surfaces at 20 results', () => {
    const list = getTool('builtin-qbank_list');
    const listQuestions = getTool('builtin-qbank_list_questions');

    expect(list.inputSchema.properties.limit).toMatchObject({
      default: 20,
      minimum: 1,
      maximum: 20,
    });
    expect(listQuestions.inputSchema.properties.page_size).toMatchObject({
      default: 20,
      minimum: 1,
      maximum: 20,
    });
    expect(instructionsFor(list.name)).toMatch(/total.*limit.*offset.*has_more.*truncated/);
    expect(instructionsFor(listQuestions.name)).toMatch(
      /total.*page.*page_size.*questions.*has_more.*truncated/,
    );
  });

  it('defines single-question creation with structured choices and a guarded undo', () => {
    const tool = getTool('builtin-qbank_create_question');

    expect(tool.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ['session_id', 'content'],
    });
    expect(tool.inputSchema.properties.question_type.enum).toContain('indefinite_choice');
    expect(tool.inputSchema.properties.options).toMatchObject({
      type: 'array',
      maxItems: 26,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'content'],
      },
    });
    expect(tool.inputSchema.properties.tags.maxItems).toBe(50);
    expect(tool.description).toMatch(/Medium/);
    expect(tool.description).toMatch(/High.*ask_user/);
    expect(instructionsFor(tool.name)).toMatch(/2000.*truncated/);
    expect(instructionsFor(tool.name)).toMatch(/reversible=false.*reversibleWithApproval=true/);
  });

  it('extends OCC updates to content, options and question_type', () => {
    const tool = getTool('builtin-qbank_update_question');

    expect(tool.inputSchema.required).toEqual([
      'session_id',
      'card_id',
      'expected_updated_at',
    ]);
    expect(tool.inputSchema.properties).toHaveProperty('content');
    expect(tool.inputSchema.properties).toHaveProperty('options');
    expect(tool.inputSchema.properties.question_type.enum).toContain('indefinite_choice');
    expect(tool.inputSchema.properties.options.items).toMatchObject({
      additionalProperties: false,
      required: ['key', 'content'],
    });
    expect(tool.inputSchema.properties.answer.maxLength).toBe(50000);
    expect(tool.inputSchema.properties.explanation.maxLength).toBe(100000);
    expect(tool.inputSchema.properties.tags).toMatchObject({
      maxItems: 50,
      items: { type: 'string', minLength: 1, maxLength: 100 },
    });
    expect(tool.inputSchema.properties.user_note.maxLength).toBe(50000);
    expect(instructionsFor(tool.name)).toMatch(/reversible=false.*reversibleWithOcc=true/);
    expect(instructionsFor(tool.name)).toMatch(/fieldsTruncated/);
  });

  it('makes batch deletion High, atomic in scope, and never remembered', () => {
    const tool = getTool('builtin-qbank_delete_questions');

    expect(tool.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ['question_ids', 'expected_updated_at_by_id'],
    });
    expect(tool.inputSchema.properties.question_ids).toMatchObject({
      minItems: 1,
      maxItems: 20,
    });
    expect(tool.inputSchema.properties.expected_updated_at_by_id).toMatchObject({
      type: 'object',
      minProperties: 1,
      additionalProperties: { type: 'string', minLength: 1 },
    });
    expect(tool.description).toMatch(/High/);
    expect(instructionsFor(tool.name)).toMatch(/每次调用.*builtin-ask_user/s);
    expect(instructionsFor(tool.name)).toMatch(/永不记忆.*禁止复用/);
    expect(instructionsFor(tool.name)).toMatch(/headless.*不得执行/);
    expect(tool.description).toMatch(/OCC冲突整批不删/);
    expect(instructionsFor(tool.name)).toMatch(/reversible=false/);
  });

  it('supports either stable question identity for favorite toggles', () => {
    const tool = getTool('builtin-qbank_toggle_favorite');

    expect(tool.inputSchema.required).toEqual(['expected_updated_at']);
    expect(tool.inputSchema.anyOf).toEqual([
      { required: ['question_id'] },
      { required: ['session_id', 'card_id'] },
    ]);
    expect(tool.description).toMatch(/Medium.*OCC.*undo/);
    expect(instructionsFor(tool.name)).toContain('2000');
    expect(instructionsFor(tool.name)).toMatch(/fieldsTruncated/);
  });

  it('keeps answers user-authored across regular and UI practice', () => {
    const regular = getTool('builtin-qbank_submit_answer');
    const timed = getTool('builtin-qbank_start_timed_practice');
    const mock = getTool('builtin-qbank_generate_mock_exam');
    const daily = getTool('builtin-qbank_get_daily_practice');

    expect(regular.description).toContain('用户明确提供');
    expect(instructionsFor(regular.name)).toContain('不得生成、猜测或代替用户作答');
    expect(timed.inputSchema.properties.duration_minutes).toMatchObject({
      minimum: 1,
      maximum: 480,
      default: 30,
    });
    expect(timed.inputSchema.properties.question_count).toMatchObject({
      minimum: 1,
      maximum: 100,
      default: 20,
    });
    expect(mock.inputSchema.required).toEqual(['session_id', 'config']);
    expect(mock.inputSchema.properties.config.properties?.total_count).toMatchObject({
      minimum: 1,
      maximum: 100,
      default: 20,
    });
    // 上限与练习面板的每日目标范围（5..=50）对齐，Agent 可续练任意用户目标
    expect(daily.inputSchema.properties.count).toMatchObject({
      minimum: 1,
      maximum: 50,
      default: 10,
    });

    for (const tool of [timed, mock, daily]) {
      expect(tool.description).toContain('handoff');
      expect(tool.description).toContain('workbenchAction');
      expect(instructionsFor(tool.name)).toContain('agentCanAnswer=false');
      expect(instructionsFor(tool.name)).toContain('payloadHydrationSupported=true');
      expect(instructionsFor(tool.name)).toContain('handoff_persisted=true');
      expect(instructionsFor(tool.name)).toContain('authoritative ACK');
    }
  });

  it('keeps mock-exam submission in the UI and exposes only an observation summary', () => {
    const embeddedNames = qbankToolsSkill.embeddedTools?.map((tool) => tool.name) ?? [];

    expect(embeddedNames).not.toContain('builtin-qbank_submit_mock_exam');
    expect(qbankToolsSkill.content).toContain('scoreSummary');
    expect(qbankToolsSkill.content).toMatch(/绝不包含答案/);
  });

  it('exposes review_only on the next-question contract', () => {
    expect(getTool('builtin-qbank_get_next_question').inputSchema.properties.review_only).toEqual({
      type: 'boolean',
      default: false,
      description: '只选择 status=review 的错题/待复习题',
    });
  });

  it.each([
    ['builtin-qbank_get_check_in_calendar', ['year', 'month']],
    ['builtin-qbank_search_questions', ['keyword']],
    ['builtin-qbank_get_learning_trend', ['start_date', 'end_date']],
    ['builtin-qbank_get_activity_heatmap', ['year']],
    ['builtin-qbank_get_knowledge_stats', undefined],
  ])('paginates %s with truthful truncation metadata', (name, required) => {
    const tool = getTool(name);

    expect(tool.inputSchema.required).toEqual(required);
    expect(tool.inputSchema.properties.page).toMatchObject({ minimum: 1, default: 1 });
    expect(tool.inputSchema.properties.page_size).toMatchObject({
      minimum: 1,
      maximum: 20,
      default: 20,
    });
    expect(instructionsFor(tool.name)).toMatch(/total.*page.*page_size.*has_more.*truncated/);
  });

  it('limits search filters to backend enums and marks field truncation', () => {
    const tool = getTool('builtin-qbank_search_questions');

    expect(tool.inputSchema.properties.sort_by.enum).toEqual([
      'relevance',
      'created_desc',
      'created_asc',
      'updated_desc',
    ]);
    expect(tool.inputSchema.properties.question_type.enum).toContain('indefinite_choice');
    expect(tool.inputSchema.properties.tags.maxItems).toBe(20);
    expect(instructionsFor(tool.name)).toContain('2000');
    expect(instructionsFor(tool.name)).toContain('fieldsTruncated');
    expect(tool.description).toMatch(/highlight_\*.*\{text,truncated\}.*null/);
  });

  it('exports generated papers only as preview or real Markdown files', () => {
    const tool = getTool('builtin-qbank_generate_paper');
    const config = tool.inputSchema.properties.config;

    expect(config.properties?.export_format.enum).toEqual(['preview', 'markdown']);
    expect(config.properties?.question_count).toMatchObject({
      minimum: 1,
      maximum: 100,
      default: 20,
    });
    expect(tool.description).toMatch(/preview.*export_path=null.*file_created=false/);
    expect(tool.description).toMatch(/markdown.*exports\/qbank\/\*\.md/);
    expect(tool.description).toMatch(/拒绝PDF\/Word/);
    expect(tool.description).toMatch(/questions.*20.*questions_truncated/);
    expect(instructionsFor(tool.name)).toContain('2000');
    expect(instructionsFor(tool.name)).toContain('fieldsTruncated');
  });

  it('documents the full build-practice-mistake-analysis-paper workflow truthfully', () => {
    const content = qbankToolsSkill.content;

    expect(content.indexOf('builtin-qbank_create_question')).toBeLessThan(
      content.indexOf('builtin-qbank_get_next_question'),
    );
    expect(content.indexOf('builtin-qbank_get_next_question')).toBeLessThan(
      content.indexOf('builtin-qbank_delete_questions'),
    );
    expect(content.indexOf('builtin-qbank_delete_questions')).toBeLessThan(
      content.indexOf('builtin-qbank_get_learning_trend'),
    );
    expect(content.indexOf('builtin-qbank_get_learning_trend')).toBeLessThan(
      content.indexOf('builtin-qbank_generate_paper'),
    );
    expect(content).toContain('agentCanAnswer=false');
    expect(content).toContain('workbenchAction.executed=false');
    expect(content).toContain('payloadHydrationSupported=true');
    expect(content).toContain('handoff_persisted=true');
    expect(content).toMatch(/workbenchAction\.tool[\s\S]*workbenchAction\.arguments/);
    expect(content).toContain('reversibleWithApproval=true');
    expect(content).toContain('reversibleWithOcc=true');
    expect(content).toMatch(/只有 Workbench 返回 authoritative ACK 后才能说题目集已打开且会话已注入/);
    expect(content).toMatch(/单页最多 20 条/);
  });
});
