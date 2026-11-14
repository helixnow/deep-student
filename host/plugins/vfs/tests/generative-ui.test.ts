import { expect, it } from 'vitest';
import { ChatV2Emitter, NoopEventSink, BackendEventsSink, type BackendEvent } from '../../chat/api.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import { getBlockTypeForToolStatic } from '../../chat-pipeline/api.ts';
import { GenerativeUiExecutor, parseIntent, validateIntentVersion, knownLayoutMode,
  parseResearchSessionId, parseSkeletonRef, parseNoteEdit, intentHasApplyNoteEdit } from '../src/tools/generative-ui.ts';

const textBlock = { type: 'text', props: { text: 'hi' } };
const intent = (extra: Record<string, unknown> = {}) => ({ version: '1', blocks: [textBlock], ...extra });
it('block_type_mapping_for_render_generative_ui_is_generative_ui', () => {
  expect(getBlockTypeForToolStatic('builtin-render_generative_ui')).toBe('generative_ui');
  expect(getBlockTypeForToolStatic('render_generative_ui')).toBe('generative_ui');
});
it('parse_intent_accepts_object', () => expect(parseIntent({ intent: intent() }).version).toBe('1'));
it('parse_intent_accepts_version_1_1', () => {
  const parsed = parseIntent({ intent: intent({ version: '1.1', layout: { mode: 'grid', columns: 2 }, blocks: [{ ...textBlock, span: 2 }] }) });
  expect(parsed.version).toBe('1.1'); expect(parsed.layout).toEqual({ mode: 'grid', columns: 2 });
  expect(parsed.blocks[0]!.span).toBe(2); expect(knownLayoutMode(parsed)).toBe('grid');
});
it('parse_intent_defaults_missing_version_as_v1', () => {
  const parsed = parseIntent({ intent: { blocks: [textBlock] } });
  expect(Object.hasOwn(parsed, 'version')).toBe(false); expect(() => validateIntentVersion(parsed)).not.toThrow();
});
it('parse_intent_ignores_unknown_layout', () => {
  const parsed = parseIntent({ intent: intent({ version: '1.1', layout: { mode: 'masonry', columns: 4 } }) });
  expect(parsed.version).toBe('1.1'); expect(knownLayoutMode(parsed)).toBeNull();
});
it('parse_intent_rejects_unknown_version', () => expect(() => parseIntent({ intent: intent({ version: '2' }) })).toThrow(/version.*2/));
it('validate_intent_version_rejects_version_2', () => expect(() => validateIntentVersion(intent({ version: '2' }))).toThrow('version'));
it('parse_intent_accepts_json_string', () => expect(parseIntent({ intent: '{"version":"1","blocks":[{"type":"alert","props":{"message":"ok"}}]}' }).blocks).toBeInstanceOf(Array));
it('parse_intent_rejects_empty_blocks', () => expect(() => parseIntent({ intent: intent({ blocks: [] }) })).toThrow());
it('parse_intent_rejects_oversized_payload', () => expect(() => parseIntent({ intent: intent({ blocks: [{ type: 'text', props: { body: 'x'.repeat(256001) } }] }) })).toThrow(/256000|上限/));
it('parse_intent_rejects_too_many_blocks', () => expect(() => parseIntent({ intent: intent({ blocks: Array.from({ length: 33 }, (_, i) => ({ type: 'text', props: { text: `block-${i}` } })) }) })).toThrow(/32|上限/));
it('parse_intent_rejects_missing_intent', () => expect(() => parseIntent({ other: true })).toThrow('intent'));
it('parse_intent_rejects_unknown_block_type', () => expect(() => parseIntent({ intent: intent({ blocks: [{ type: 'unknown-widget', props: {} }] }) })).toThrow(/type.*unknown-widget/));
it('parse_intent_rejects_missing_block_type', () => expect(() => parseIntent({ intent: intent({ blocks: [{ props: { text: 'hi' } }] }) })).toThrow('type'));
it('parse_intent_rejects_non_object_block', () => expect(() => parseIntent({ intent: intent({ blocks: ['text'] }) })).toThrow('对象'));
it('parse_intent_accepts_all_registered_block_types', () => {
  const blocks = ['stat-card', 'alert', 'list', 'progress', 'action-bar', 'text', 'key-value-grid', 'flashcard-preview',
    'review-calendar', 'mistake-analysis', 'mindmap-embed', 'paper-digest', 'research-plan', 'research-report', 'markdown', 'chart', 'steps', 'table']
    .map(type => ({ type, props: {} }));
  expect(parseIntent({ intent: intent({ blocks }) }).blocks).toHaveLength(18);
});
it('parse_research_session_id_accepts_non_empty_string', () => expect(parseResearchSessionId({ researchSessionId: ' hpias-s1 ' }, null)).toBe('hpias-s1'));
it('parse_research_session_id_rejects_blank', () => expect(parseResearchSessionId({ researchSessionId: '   ' }, null)).toBeNull());
it('parse_research_session_id_rejects_unsafe_or_oversized', () => {
  for (const researchSessionId of ['x'.repeat(129), '../evil', 'javascript:alert(1)']) expect(parseResearchSessionId({ researchSessionId }, null)).toBeNull();
});
it('parse_research_session_id_falls_back_to_intent_meta', () => {
  const value = intent({ meta: { researchSessionId: ' meta-s1 ' }, blocks: [{ type: 'research-plan', props: { title: 'Plan', steps: [] } }] });
  expect(parseResearchSessionId({ intent: value }, value)).toBe('meta-s1');
});
it('parse_research_session_id_prefers_top_level_over_meta', () => expect(parseResearchSessionId({ researchSessionId: 'top-s1' }, { meta: { researchSessionId: 'meta-s1' } })).toBe('top-s1'));
it('parse_skeleton_ref_accepts_valid_skill_id', () => expect(parseSkeletonRef({ skeletonRef: 'weekly-report' })).toBe('weekly-report'));
it('parse_skeleton_ref_rejects_invalid_or_absent', () => {
  expect(parseSkeletonRef({})).toBeNull();
  for (const skeletonRef of [42, 'bad id', '../escape', 'a'.repeat(200)]) expect(parseSkeletonRef({ skeletonRef })).toBeNull();
});
it('parse_note_edit_accepts_append_payload', () => expect(parseNoteEdit({ noteEdit: { operation: 'append', content: '## Summary' } })!.operation).toBe('append'));
it('parse_note_edit_rejects_invalid_operation', () => expect(() => parseNoteEdit({ noteEdit: { operation: 'delete' } })).toThrow());
it('parse_note_edit_rejects_regex_flag', () => expect(() => parseNoteEdit({ noteEdit: { operation: 'replace', search: '(a+)+$', replace: 'x', isRegex: true } })).toThrow('isRegex'));
it('parse_note_edit_rejects_oversized_payload', () => expect(() => parseNoteEdit({ noteEdit: { operation: 'append', content: 'x'.repeat(256 * 1024 + 1) } })).toThrow('262144'));
it('parse_note_edit_strips_unknown_fields', () => {
  expect(parseNoteEdit({ noteEdit: { operation: 'append', content: '## Summary', className: 'x', isRegex: false } })).toEqual({ operation: 'append', content: '## Summary' });
});
it('parse_note_edit_rejects_non_string_fields', () => expect(() => parseNoteEdit({ noteEdit: { operation: 'append', content: ['not', 'a', 'string'] } })).toThrow('content'));
const applyIntent = intent({ blocks: [{ type: 'action-bar', props: { actions: [{ id: 'apply-note-edit', label: 'Apply' }] } }] });
it('intent_has_apply_note_edit_detects_action_bar_id', () => expect(intentHasApplyNoteEdit(applyIntent)).toBe(true));

function executor() { return new GenerativeUiExecutor(() => { throw new Error('No frontend in these Rust windowless tests'); }); }
async function execute(args: unknown, name = 'render_generative_ui') {
  const emitter = new ChatV2Emitter(new NoopEventSink(), 'generative-ui-test-session');
  const persisted: unknown[] = [];
  const result = await executor().execute({ id: 'call-generative-ui', name, arguments: args }, {
    message_id: 'generative-ui-test-message', block_id: 'block-generative-ui', variant_id: null,
    skill_state_version: null, round_id: null, emitter, tryWindow: () => null,
    saveToolBlock: result => { persisted.push(result); },
  });
  expect(persisted).toEqual([result]);
  return result;
}
it('execute_preserves_research_session_id_in_output', async () => {
  const result = await execute({ researchSessionId: 'research-chat-1', intent: intent({ blocks: [{ type: 'research-plan', props: { title: 'Plan', steps: [] } }] }) });
  expect(result.success).toBe(true); expect(result.output).toMatchObject({ researchSessionId: 'research-chat-1' });
});
it('execute_preserves_note_edit_in_tool_arguments', async () => {
  const result = await execute({ intent: applyIntent, noteEdit: { operation: 'set', content: '# Title' } });
  expect(result.success).toBe(true); expect(result.input).toMatchObject({ noteEdit: { operation: 'set' } });
});
it('execute_fails_when_apply_note_edit_without_note_edit_payload', async () => {
  const result = await execute({ intent: applyIntent }); expect(result.success).toBe(false); expect(result.error).toContain('noteEdit');
});
it('can_handle_namespaced_and_plain_tool_name', () => {
  const value = executor(); expect(value.canHandle('render_generative_ui')).toBe(true);
  expect(value.canHandle('builtin-render_generative_ui')).toBe(true); expect(value.canHandle('rag_search')).toBe(false);
});
it('execute_success_returns_rendered_status_and_block_count', async () => {
  const result = await execute({ intent: intent({ meta: { title: 'Learning briefing' }, blocks: [
    { type: 'stat-card', props: { title: 'Due', value: 3 } }, { type: 'action-bar', props: { actions: [] } },
  ] }) }, 'builtin-render_generative_ui');
  expect(result.success).toBe(true); expect(result.output).toEqual({ status: 'rendered', blockCount: 2 });
  expect(result.toolName).toBe('builtin-render_generative_ui');
});
it('execute_failure_on_empty_blocks_returns_error_result', async () => {
  const result = await execute({ intent: intent({ blocks: [] }) }); expect(result.success).toBe(false); expect(result.error).toContain('blocks');
});
it('execute_v1_1_grid_layout_returns_rendered', async () => {
  const result = await execute({ intent: intent({ version: '1.1', layout: { mode: 'grid', columns: 2 }, blocks: [{ type: 'stat-card', props: { title: 'Due', value: 3 }, span: 2 }] }) });
  expect(result.success).toBe(true); expect(result.output).toEqual({ status: 'rendered', blockCount: 1 });
  expect(result.input).toMatchObject({ intent: { layout: { mode: 'grid' } } });
});
it('execute_rejects_version_2', async () => {
  const result = await execute({ intent: intent({ version: '2' }) }); expect(result.success).toBe(false); expect(result.error).toContain('version');
});

it('emits start/chunk/end with scope metadata before research dispatch and ignores persistence failure', async () => {
  const started: unknown[] = [];
  const research = { startFromIntent(request: unknown) { started.push(request); } };
  const host = await createTestHost({ provide: { hpiasResearch: research } });
  try {
    const emitter = new ChatV2Emitter(new BackendEventsSink(host.ctx.backendEvents), 'generative-scoped', false);
    const value = intent({ meta: { title: 'Plan' }, blocks: [{ type: 'research-plan', props: {} }] });
    const instance = new GenerativeUiExecutor(() => {
      const events = host.eventsNamed('chat_v2_event_generative-scoped') as BackendEvent[];
      expect(events.map(event => event.phase)).toEqual(['start', 'chunk', 'end']);
      return research;
    });
    const result = await instance.execute({ id: 'call1', name: 'render_generative_ui',
      arguments: { intent: value, researchSessionId: ' research1 ', skeletonRef: 'weekly-report' } }, {
      message_id: 'm1', block_id: 'b1', variant_id: 'v1', skill_state_version: 7, round_id: 'r1', emitter,
      tryWindow: () => ({ window: 'main', webview: 'main' }), saveToolBlock() { throw new Error('persist failure'); },
    });
    expect(result.success).toBe(true);
    const events = host.eventsNamed('chat_v2_event_generative-scoped') as BackendEvent[];
    expect(events).toHaveLength(3);
    for (const event of events) expect(event).toMatchObject({ type: 'generative_ui', variantId: 'v1', skillStateVersion: 7, roundId: 'r1' });
    expect(events[1]!.chunk).toBe(JSON.stringify(value));
    expect(events[2]!.result).toEqual({ intent: value, isStreaming: false, researchSessionId: 'research1', skeletonRef: 'weekly-report' });
    expect(started).toEqual([{ window: { window: 'main', webview: 'main' }, sessionId: 'research1', title: 'Plan', intent: value }]);
  } finally { await host.dispose(); }
});
