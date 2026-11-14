import { expect, it } from 'vitest';
import type {
  ChatAnkiRefResolver, ChatAnkiRoutePlanner, ContextRef, ToolExecutionContext,
  ToolResultInfo, VfsContextRefData, VfsResourceRef,
} from '../api.ts';
import { ChatAnkiExecutor, collectRefTextForMetrics } from '../src/chatanki-executor.ts';
import {
  buildAnalyzeOutput, buildGenerationOptions, countEntryLikeLines, defaultGenerationTuning,
  resolveRouteDecision,
} from '../src/executor-helpers.ts';

function context(events: unknown[], saved: ToolResultInfo[]): ToolExecutionContext {
  return {
    sessionId: 'session-analyze', messageId: 'msg-analyze', blockId: 'block-analyze',
    emitToolCallStart: (...args) => { events.push(['start', ...args]); },
    emitToolCallEnd: (value) => { events.push(['end', value]); },
    emitToolCallError: (error) => { events.push(['error', error]); },
    saveToolBlock: (value) => { saved.push(value); },
    warn: (message) => { events.push(['warn', message]); },
  };
}

async function runAnalyze(
  content: string, goal: string | null = null,
): Promise<ToolResultInfo> {
  const args: Record<string, unknown> = { content };
  if (goal !== null) args.goal = goal;
  return runAnalyzeArgs(args);
}

async function runAnalyzeArgs(args: Record<string, unknown>): Promise<ToolResultInfo> {
  const executor = new ChatAnkiExecutor();
  return executor.execute(
    { id: 'call-analyze', name: 'chatanki_analyze', arguments: args },
    context([], []),
  );
}

function outputOf(result: ToolResultInfo): Record<string, unknown> {
  expect(result.success).toBe(true);
  return result.output as Record<string, unknown>;
}

it('test_execute_analyze_text_only_is_heuristic_simple_text', async () => {
  const plain = await runAnalyze('这是一段普通的学习材料。\n它没有词典式结构。', '复习');
  expect(plain.success).toBe(true);
  const output = outputOf(plain);
  const routing = output.routing as Record<string, unknown>;
  const metrics = output.metrics as Record<string, unknown>;
  const recommended = output.recommended as Record<string, unknown>;
  expect(output.status).toBe('ok');
  expect(output.goal).toBe('复习');
  expect(routing.route).toBe('simple_text');
  expect(routing.routeSource).toBe('heuristic');
  expect(routing.confidence).toBeNull();
  expect(routing.glossaryMode).toBe(false);
  expect(String(routing.reason)).toContain('启发式');
  expect(recommended.route).toBe('simple_text');
  expect(metrics.nonEmptyLines).toBe(2);
  expect(metrics.refTotal).toBeUndefined();
});

it('test_execute_analyze_recommended_aligns_build_generation_options', async () => {
  const glossaryContent = Array.from({ length: 40 }, () => '术语：定义').join('\n');
  const glossary = outputOf(await runAnalyze(glossaryContent));
  const glossaryOptions = buildGenerationOptions(
    'goal', 'Default', 'Basic', glossaryContent, null, null, null,
    defaultGenerationTuning(), null,
  );
  const glossaryRecommended = glossary.recommended as Record<string, unknown>;
  expect(glossaryRecommended.glossaryMode).toBe(true);
  expect(glossaryRecommended.temperature).toBe(glossaryOptions.temperature);
  expect(glossaryRecommended.maxOutputTokensOverride)
    .toBe(glossaryOptions.max_output_tokens_override);
  expect(glossaryRecommended.segmentOverlapSize).toBe(glossaryOptions.segment_overlap_size);
  expect(glossaryRecommended.pipelineDefaultMaxCards)
    .toBe(glossaryOptions.max_cards_per_mistake);

  const plainContent = '这是一段普通的学习材料。\n它没有词典式结构。';
  const plain = outputOf(await runAnalyze(plainContent));
  const plainOptions = buildGenerationOptions(
    'goal', 'Default', 'Basic', plainContent, null, null, null,
    defaultGenerationTuning(), null,
  );
  const plainRecommended = plain.recommended as Record<string, unknown>;
  expect(plainRecommended.glossaryMode).toBe(false);
  expect(plainRecommended.temperature).toBe(plainOptions.temperature);
  expect(plainRecommended.maxOutputTokensOverride).toBeNull();
  expect(plainOptions.max_output_tokens_override).toBeNull();
  expect(plainRecommended.segmentOverlapSize).toBe(plainOptions.segment_overlap_size);
  expect(plainRecommended.pipelineDefaultMaxCards).toBe(plainOptions.max_cards_per_mistake);
});

it('test_execute_analyze_glossary_metrics_share_entry_counting', async () => {
  const glossaryContent = Array.from({ length: 40 }, () => '术语：定义').join('\n');
  const glossary = outputOf(await runAnalyze(glossaryContent));
  const glossaryRouting = glossary.routing as Record<string, unknown>;
  const glossaryMetrics = glossary.metrics as Record<string, unknown>;
  expect(glossaryRouting.glossaryMode).toBe(true);
  expect(glossaryRouting.route).toBe('simple_text');
  expect(glossaryRouting.routeSource).toBe('heuristic');
  expect(glossaryMetrics.nonEmptyLines).toBe(40);
  expect(glossaryMetrics.entryLikeLines).toBe(countEntryLikeLines(glossaryContent));
  expect(glossary.goal).toBeNull();

  const shortDigit = outputOf(await runAnalyze(Array.from({ length: 40 }, () => '12').join('\n')));
  expect((shortDigit.metrics as Record<string, unknown>).entryLikeLines).toBe(0);
  expect((shortDigit.routing as Record<string, unknown>).glossaryMode).toBe(false);
});

it('test_execute_analyze_forced_route_source', async () => {
  const forced = outputOf(await runAnalyzeArgs({ content: '一段普通文本', route: 'vlm_full' }));
  const routing = forced.routing as Record<string, unknown>;
  expect(routing.route).toBe('vlm_full');
  expect(routing.routeSource).toBe('forced');
  expect(routing.confidence).toBeNull();
  expect((forced.recommended as Record<string, unknown>).route).toBe('vlm_full');
});

it('test_execute_analyze_rejects_invalid_route', async () => {
  const result = await runAnalyzeArgs({ content: '一段普通文本', route: 'banana' });
  expect(result.success).toBe(false);
  expect(result.error).toContain("Invalid route 'banana'");
});

it('test_execute_analyze_rejects_blank_input', async () => {
  const result = await runAnalyze('   \n\t  ');
  expect(result.success).toBe(false);
  expect(result.error).toBe('content or resourceIds is required');

  const empty = await runAnalyzeArgs({});
  expect(empty.success).toBe(false);
  expect(empty.error).toBe('content or resourceIds is required');
});

it('test_execute_analyze_unresolvable_refs_fail_open_with_warning', async () => {
  const result = outputOf(await runAnalyzeArgs({
    content: '一段普通文本', resourceIds: ['file_missing_123'],
  }));
  const routing = result.routing as Record<string, unknown>;
  expect(routing.route).toBe('simple_text');
  expect(routing.routeSource).toBe('heuristic');
  const warnings = result.warnings as Array<Record<string, unknown>>;
  expect(warnings[0]?.code).toBe('analyze_refs_unresolved');
  expect(warnings[0]?.unresolvedIds).toEqual(['file_missing_123']);
});

it('test_execute_analyze_suggested_max_cards_boundaries', async () => {
  const short = outputOf(await runAnalyze('很短的材料'));
  expect((short.recommended as Record<string, unknown>).maxCards).toBe(10);

  const medium = outputOf(await runAnalyze('字'.repeat(600)));
  expect((medium.recommended as Record<string, unknown>).maxCards).toBe(30);

  const long = outputOf(await runAnalyze('字'.repeat(2_500)));
  expect((long.recommended as Record<string, unknown>).maxCards).toBe(80);

  const glossary = outputOf(await runAnalyze(Array.from({ length: 40 }, () => '术语：定义').join('\n')));
  expect((glossary.recommended as Record<string, unknown>).maxCards).toBe(44);
  const huge = outputOf(await runAnalyze(Array.from({ length: 500 }, () => '术语：定义').join('\n')));
  expect((huge.recommended as Record<string, unknown>).maxCards).toBe(100);
  expect((huge.recommended as Record<string, unknown>).pipelineDefaultMaxCards).toBe(0);
});

it('test_execute_analyze_missing_llm_manager_falls_back_to_heuristic', async () => {
  const { result } = await runAnalyzeWithPlanner(null);
  expect(result.success).toBe(true);
  const routing = (result.output as Record<string, unknown>).routing as Record<string, unknown>;
  expect(routing.route).toBe('simple_text');
  expect(routing.routeSource).toBe('heuristic');
  expect(routing.confidence).toBeNull();
});

it('test_analyze_metrics_include_referenced_file_text', () => {
  let table = '单词\t音标\t词性\t中文释义\n';
  for (let index = 0; index < 60; index += 1) {
    table += `word${index}\t/w${index}/\tv.\t释义${index}\n`;
  }
  const ref: VfsResourceRef = {
    sourceId: 'file_vocab', resourceHash: '', type: 'file', name: '词表.xlsx',
    resourceId: null, snippet: null, injectModes: null,
  };
  const refData: VfsContextRefData = { refs: [ref], truncated: false, totalCount: 1 };
  const text = collectRefTextForMetrics('', refData, () => table);
  expect(text.split('\n').length).toBeGreaterThanOrEqual(61);
  const output = buildAnalyzeOutput(
    null, text, refData,
    resolveRouteDecision('simple_text', null, refData), [],
  );
  expect((output.metrics as Record<string, unknown>).nonEmptyLines as number)
    .toBeGreaterThanOrEqual(61);
  expect((output.recommended as Record<string, unknown>).maxCards as number)
    .toBeGreaterThanOrEqual(30);
});


function refResolver(): ChatAnkiRefResolver {
  const fileRef: ContextRef = {
    resourceId: 'file_analyze_route', hash: 'hash-file', typeId: 'file',
    displayName: '讲义.md',
  };
  return {
    resolveSessionRefs: (_sessionId, ids) =>
      ids.includes(fileRef.resourceId) ? [fileRef] : [],
    resolveVfsRef: () => null,
    refText: () => '这一段是讲义正文，包含普通概念解释。',
  };
}

async function runAnalyzeWithPlanner(
  planner: ChatAnkiRoutePlanner | null, refs: ChatAnkiRefResolver | null = refResolver(),
  llmManagerPresent?: boolean,
): Promise<{ result: ToolResultInfo; warnings: string[] }> {
  const warnings: string[] = [];
  const executor = new ChatAnkiExecutor();
  const result = await executor.execute(
    {
      id: 'call-analyze-route', name: 'chatanki_analyze',
      arguments: { content: '请分析这份讲义', resourceIds: ['file_analyze_route'] },
    },
    {
      sessionId: 'session-analyze', messageId: 'msg-analyze', blockId: 'block-analyze',
      refs, llmPlanner: planner, llmManagerPresent,
      emitToolCallStart: () => undefined,
      emitToolCallEnd: () => undefined,
      emitToolCallError: () => undefined,
      saveToolBlock: () => undefined,
      warn: (message) => { warnings.push(message); },
    },
  );
  return { result, warnings };
}

it('test_execute_analyze_consumes_confident_planner_route', async () => {
  const calls: Array<[string, string]> = [];
  const planner: ChatAnkiRoutePlanner = {
    async callAnkiRoutedRawPrompt(task, prompt) {
      calls.push([task, prompt]);
      return '```json\n{"route":"vlm_light","confidence":0.92,"glossaryMode":false,"reason":"少量图表"}\n```';
    },
  };
  const { result } = await runAnalyzeWithPlanner(planner);
  expect(result.success).toBe(true);
  const routing = (result.output as Record<string, unknown>).routing as Record<string, unknown>;
  expect(routing.route).toBe('vlm_light');
  expect(routing.routeSource).toBe('llm');
  expect(routing.confidence).toBeCloseTo(0.92, 5);
  expect(calls[0]?.[0]).toBe('chatanki.plan_route');
  expect(calls[0]?.[1]).toContain('学习目标');
  expect(calls[0]?.[1]).toContain('讲义.md');
});

it('test_execute_analyze_low_confidence_planner_falls_back_to_heuristic', async () => {
  const planner: ChatAnkiRoutePlanner = {
    async callAnkiRoutedRawPrompt() {
      return '{"route":"vlm_full","confidence":0.2,"reason":"uncertain"}';
    },
  };
  const { result } = await runAnalyzeWithPlanner(planner);
  const routing = (result.output as Record<string, unknown>).routing as Record<string, unknown>;
  expect(routing.routeSource).toBe('heuristic');
  expect(routing.confidence).toBeNull();
});

it('test_execute_analyze_planner_failure_warns_and_falls_back', async () => {
  const planner: ChatAnkiRoutePlanner = {
    async callAnkiRoutedRawPrompt() { throw new Error('planner offline'); },
  };
  const { result, warnings } = await runAnalyzeWithPlanner(planner);
  expect(result.success).toBe(true);
  const routing = (result.output as Record<string, unknown>).routing as Record<string, unknown>;
  expect(routing.routeSource).toBe('heuristic');
  expect(warnings.some((message) => message.includes('planner offline'))).toBe(true);
});

it('test_execute_analyze_requires_planner_when_llm_manager_exists', async () => {
  const { result } = await runAnalyzeWithPlanner(null, refResolver(), true);
  expect(result.success).toBe(false);
  expect(result.error).toContain('requires the L02 route planner');
  expect(result.error).toContain('the LLM manager is present but does not expose it');
});

it('chatanki_analyze argument errors use serde_json from_value text (rs:1680-1693,5575-5579)', async () => {
  const errorOf = async (args: unknown): Promise<string | undefined> => {
    const result = await new ChatAnkiExecutor().execute(
      { id: 'call-analyze-args', name: 'chatanki_analyze', arguments: args as Record<string, unknown> },
      context([], []),
    );
    expect(result.success).toBe(false);
    return result.error;
  };
  const prefix = 'Invalid chatanki_analyze arguments: ';
  expect(await errorOf({ content: 5 })).toBe(`${prefix}invalid type: number, expected a string`);
  expect(await errorOf({ goal: true })).toBe(`${prefix}invalid type: boolean \`true\`, expected a string`);
  expect(await errorOf({ resourceIds: 'file_a' })).toBe(`${prefix}invalid type: string "file_a", expected a sequence`);
  expect(await errorOf({ resourceIds: ['file_a', null] })).toBe(`${prefix}invalid type: null, expected a string`);
  // preserve_order: the first bad key in input order wins.
  expect(await errorOf({ route: 1, content: false })).toBe(`${prefix}invalid type: number, expected a string`);
  expect(await errorOf('x')).toBe(`${prefix}invalid type: string "x", expected struct ChatAnkiAnalyzeArgs`);
  expect(await errorOf(['text'])).toBe(`${prefix}invalid length 1, expected struct ChatAnkiAnalyzeArgs with 5 elements`);
});

it('chatanki_analyze ignores snake_case resource_id (rename_all camelCase, alias equals renamed name)', async () => {
  const result = await runAnalyzeArgs({ content: '这是一段普通的学习材料。', resource_id: 'file_ignored' });
  expect(result.success).toBe(true);
});
