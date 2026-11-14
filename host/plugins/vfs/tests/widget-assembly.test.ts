import { describe, expect, it, vi } from 'vitest';
import { GenerativeUiExecutor, WidgetAssembler, WidgetAssemblyManager, applyArtifactPatch,
  parseIntent, parseWidgetAssemblyArgs, type GenerativeUiExecutionContext } from '../src/tools/generative-ui.ts';

const append = (code: string, revision = 0, offset = 0, extra = {}) =>
  ({ format: 'html', action: 'append', code, revision, offset, ...extra });
const action = (name: string, revision: number, extra = {}) =>
  ({ format: 'html', action: name, code: '', revision, ...extra });
const read = (assembler: WidgetAssembler, extra = {}) => assembler.execute({ format: 'html', action: 'read', code: '', offset: 0, ...extra });

describe('task-local widget assembly', () => {
  it('append -> read -> patch -> complete delivers the whole source and metadata', () => {
    const assembler = new WidgetAssembler();
    expect(assembler.execute(append('<div>旧', 0, 0, { title: '讲解', libs: ['chart.js'] })))
      .toMatchObject({ revision: 1, length: 6, status: 'assembling-not-runnable' });
    assembler.execute(append('</div>', 1, 6));
    expect(read(assembler)).toMatchObject({ revision: 2, length: 12, offset: 0, content: '<div>旧</div>', nextOffset: null });
    expect(assembler.execute(action('patch', 2, { edits: [{ search: '旧', replace: '新' }] }))).toMatchObject({ revision: 3, length: 12 });
    const accept = vi.fn();
    expect(assembler.execute(action('complete', 3, { offset: 12 }), accept)).toMatchObject({
      status: 'completed', revision: 4, length: 0, widget: { code: '<div>新</div>', title: '讲解', libs: ['chart.js'] },
    });
    expect(accept).toHaveBeenCalledWith({ code: '<div>新</div>', title: '讲解', libs: ['chart.js'] });
    expect(read(assembler)).toMatchObject({ status: 'empty', revision: 4, content: '' });
  });
  it('rejects stale revisions including all mutations after equal-length edits', () => {
    const assembler = new WidgetAssembler();
    assembler.execute(append('old'));
    assembler.execute(action('patch', 1, { edits: [{ search: 'old', replace: 'new' }] }));
    for (const args of [append('!', 1, 3), action('patch', 1, { edits: [{ search: 'new', replace: 'old' }] }),
      action('complete', 1, { offset: 3 }), action('discard', 1), { format: 'html', action: 'read', code: '', offset: 0, revision: 1 }]) {
      expect(() => assembler.execute(args)).toThrow('revision_conflict');
    }
    expect(read(assembler)).toMatchObject({ revision: 2, content: 'new' });
  });
  it.each(['discard', 'complete'])('prevents ABA after %s and a fresh same-length append', name => {
    const assembler = new WidgetAssembler();
    assembler.execute(append('one'));
    assembler.execute(action(name, 1, name === 'complete' ? { offset: 3 } : {}));
    expect(() => assembler.execute(append('two'))).toThrow('revision_conflict');
    assembler.execute(append('two', 2));
    expect(() => assembler.execute(action('complete', 1, { offset: 3 }))).toThrow('revision_conflict');
    expect(read(assembler)).toMatchObject({ revision: 3, content: 'two' });
  });
  it('isolates sessions, tasks, executor managers and explicit task release', () => {
    const manager = new WidgetAssemblyManager();
    manager.get('s1', 't1').execute(append('one'));
    expect(read(manager.get('s1', 't1')).content).toBe('one');
    for (const assembler of [manager.get('s2', 't1'), manager.get('s1', 't2'), new WidgetAssemblyManager().get('s1', 't1')]) {
      expect(read(assembler)).toMatchObject({ revision: 0, length: 0 });
    }
    manager.release('s1', 't1');
    expect(read(manager.get('s1', 't1')).revision).toBe(0);
    manager.release('s1');
    expect(read(manager.get('s1', 't2')).revision).toBe(0);
  });
  it('direct source neither overwrites nor advances an active buffer', () => {
    const assembler = new WidgetAssembler();
    assembler.execute(append('pending'));
    expect(assembler.execute({ format: 'html', code: '<p>direct</p>' }).widget?.code).toBe('<p>direct</p>');
    expect(read(assembler)).toMatchObject({ revision: 1, content: 'pending' });
    expect(() => assembler.execute({ format: 'html', code: 'direct', offset: 0 })).toThrow('action required');
  });
  it('requires exact offsets and first-chunk-only metadata, without mutation on failure', () => {
    const assembler = new WidgetAssembler();
    expect(() => assembler.execute({ format: 'html', action: 'append', revision: 0, code: 'a' })).toThrow('offset_conflict');
    assembler.execute(append('a'));
    expect(() => assembler.execute(append('b', 1, 0))).toThrow('offset_conflict');
    expect(() => assembler.execute(append('b', 1, 1, { title: 'later' }))).toThrow('metadata_only_on_first');
    expect(() => assembler.execute(action('complete', 1, { offset: 2 }))).toThrow('offset_conflict');
    expect(read(assembler)).toMatchObject({ revision: 1, content: 'a' });
  });
  it('retains content and revision when delivery fails, allowing repair and retry', () => {
    const assembler = new WidgetAssembler();
    assembler.execute(append('<script>'));
    expect(() => assembler.execute(action('complete', 1, { offset: 8 }))).toThrow('incomplete');
    assembler.execute(append('</script>', 1, 8));
    expect(() => assembler.execute(action('complete', 2, { offset: 17 }), () => { throw new Error('delivery failed'); })).toThrow('delivery failed');
    expect(read(assembler)).toMatchObject({ revision: 2, content: '<script></script>' });
    expect(assembler.execute(action('complete', 2, { offset: 17 })).revision).toBe(3);
  });
  it('handles UTF-16 paging without splitting surrogate pairs', () => {
    const assembler = new WidgetAssembler();
    assembler.execute(append('a😀b'));
    expect(read(assembler, { limit: 2 })).toMatchObject({ content: 'a', nextOffset: 1, length: 4 });
    expect(read(assembler, { offset: 1, limit: 2 })).toMatchObject({ content: '😀', nextOffset: 3 });
    expect(read(assembler, { offset: 4 })).toMatchObject({ content: '', nextOffset: null });
    expect(() => read(assembler, { offset: 2 })).toThrow('unicode_boundary');
    expect(() => read(assembler, { offset: 1, limit: 1 })).toThrow('read_limit');
    expect(() => assembler.execute(append('\ud800', 1, 4))).toThrow('unicode_boundary');
    expect(() => assembler.execute(action('patch', 1, { edits: [{ search: '\ud83d', replace: 'x' }] }))).toThrow('unicode_boundary');
    expect(applyArtifactPatch('a😀b', [{ search: '😀', replace: '🙂' }])).toBe('a🙂b');
  });
  it.each([0, 4001, 1.5])('rejects read limit %s', limit => {
    expect(() => read(new WidgetAssembler(), { limit })).toThrow('read');
  });
  it('defaults read limit to 2000 and enforces append/total UTF-16 bounds', () => {
    const assembler = new WidgetAssembler();
    expect(() => assembler.execute(append(''))).toThrow('chunk');
    expect(() => assembler.execute(append('x'.repeat(6001)))).toThrow('chunk');
    for (let i = 0; i < 10; i++) assembler.execute(append('x'.repeat(6000), i, i * 6000));
    expect(read(assembler).content).toHaveLength(2000);
    expect(() => assembler.execute(append('x', 10, 60000))).toThrow('too_large');
    expect(read(assembler)).toMatchObject({ revision: 10, length: 60000 });
    expect(() => applyArtifactPatch(`a${'x'.repeat(59999)}`, [{ search: 'a', replace: 'aa' }])).toThrow('too_large');
    expect(() => parseWidgetAssemblyArgs({ format: 'html', code: 'x'.repeat(60001) })).toThrow('60000');
  });
});

describe('atomic exact patch', () => {
  it('applies simultaneous same-source edits, anchor insertions and deletions', () => {
    expect(applyArtifactPatch('alpha beta gamma', [{ search: 'alpha', replace: 'beta' }, { search: 'beta', replace: 'B' }])).toBe('beta B gamma');
    expect(applyArtifactPatch('<p>old</p>', [{ search: '<p>', replace: '<p>new ' }, { search: 'old', replace: '' }])).toBe('<p>new </p>');
  });
  it.each([
    { source: 'abc', edits: [{ search: 'missing', replace: 'x' }], error: 'no_match' },
    { source: 'ababa', edits: [{ search: 'aba', replace: 'x' }], error: 'multiple_matches' },
    { source: 'abc', edits: [{ search: 'ab', replace: 'x' }, { search: 'bc', replace: 'y' }], error: 'overlap' },
    { source: 'abc', edits: [{ search: 'a', replace: 'a' }], error: 'no_change' },
    { source: 'abc', edits: [{ search: '', replace: 'x' }], error: 'patch_edit' },
    { source: 'abc', edits: [{ search: 'abc', replace: '' }], error: 'empty_result' },
  ])('rejects $error without changing pending source or revision', ({ source, edits, error }) => {
    const assembler = new WidgetAssembler(); assembler.execute(append(source));
    expect(() => assembler.execute(action('patch', 1, { edits }))).toThrow(error);
    expect(read(assembler)).toMatchObject({ content: source, revision: 1 });
  });
  it('does not apply an earlier valid edit when a later edit fails', () => {
    const assembler = new WidgetAssembler(); assembler.execute(append('abc'));
    expect(() => assembler.execute(action('patch', 1, { edits: [{ search: 'a', replace: 'A' }, { search: 'z', replace: 'Z' }] }))).toThrow('no_match');
    expect(read(assembler)).toMatchObject({ content: 'abc', revision: 1 });
  });
  it('bounds edit count and aggregate UTF-16 size and rejects unknown fields', () => {
    for (const edits of [[], Array.from({ length: 21 }, () => ({ search: 'a', replace: 'b' })),
      [{ search: 'a', replace: 'b'.repeat(6000) }], [{ search: 'a', replace: 'b', unrelated: true }]]) {
      expect(() => applyArtifactPatch('a', edits)).toThrow();
    }
    expect(applyArtifactPatch('a', [{ search: 'a', replace: '\u0000'.repeat(5999) }])).toHaveLength(5999);
  });
  it('rejects inappropriate action fields, code and malformed arguments', () => {
    for (const args of [null, { format: 'html', code: '' }, action('read', 0, { offset: 0, title: 'no' }),
      action('patch', 0, { edits: [{ search: 'a', replace: 'b' }], offset: 0 }),
      { ...action('discard', 0), code: 'not empty' }, action('unknown', 0), append('a', -1),
      append('a', 0, 0, { libs: ['remote.js'] })]) expect(() => parseWidgetAssemblyArgs(args)).toThrow();
  });
});

function context(session = 's', task = 't') {
  const emitted: { phase: string; value: unknown }[] = [];
  const ctx: GenerativeUiExecutionContext = {
    session_id: session, runId: () => task, message_id: task, block_id: 'b', variant_id: null,
    skill_state_version: null, round_id: null, tryWindow: () => null, saveToolBlock: vi.fn(),
    emitter: {
      emitStartWithMeta: (...args: unknown[]) => emitted.push({ phase: 'start', value: args[3] }),
      emitChunkWithMeta: (...args: unknown[]) => emitted.push({ phase: 'chunk', value: args[2] }),
      emitEndWithMeta: (...args: unknown[]) => emitted.push({ phase: 'end', value: args[2] }),
      emitErrorWithMeta: (...args: unknown[]) => emitted.push({ phase: 'error', value: args[2] }),
    } as unknown as GenerativeUiExecutionContext['emitter'],
  };
  return { ctx, emitted };
}
const call = (args: unknown) => ({ id: 'c', name: 'render_generative_ui', arguments: args });
describe('GenerativeUiExecutor integration', () => {
  it('keeps legacy parsing, results and event order unchanged', async () => {
    const executor = new GenerativeUiExecutor(() => { throw new Error('unused'); });
    const { ctx, emitted } = context();
    const intent = { version: '1.1', blocks: [{ type: 'text', props: { text: 'legacy' } }] };
    expect(parseIntent({ intent: JSON.stringify(intent) })).toEqual(intent);
    expect(() => parseIntent({ intent: { blocks: [{ type: 'html' }] } })).toThrow('type');
    const result = await executor.execute(call({ intent }), ctx);
    expect(result.output).toEqual({ status: 'rendered', blockCount: 1 });
    expect(emitted.map(event => event.phase)).toEqual(['start', 'chunk', 'end']);
    expect(emitted[2]!.value).toEqual({ intent, isStreaming: false });
    expect(ctx.saveToolBlock).toHaveBeenCalledWith(result);
    expect(executor.canHandle('builtin-render_generative_ui')).toBe(true);
    expect((await executor.execute(call({ intent: { blocks: [] } }), ctx)).success).toBe(false);
  });
  it('does not emit runnable HTML until complete, then emits a standard generative_ui intent', async () => {
    const executor = new GenerativeUiExecutor(() => { throw new Error('unused'); });
    const { ctx, emitted } = context();
    expect((await executor.execute(call(append('<p>old</p>', 0, 0, { title: 'Demo' })), ctx)).output)
      .toMatchObject({ status: 'assembling-not-runnable', revision: 1 });
    expect((await executor.execute(call({ widgetAssembly: { action: 'read', code: '', offset: 0 } }), ctx)).output)
      .toMatchObject({ content: '<p>old</p>', revision: 1 });
    await executor.execute(call(action('patch', 1, { edits: [{ search: 'old', replace: 'new' }] })), ctx);
    expect(emitted).toEqual([]);
    const result = await executor.execute(call(action('complete', 2, { offset: 10 })), ctx);
    expect(result.output).toMatchObject({ status: 'rendered', blockCount: 1, assembly: { status: 'completed', revision: 3, length: 0 } });
    expect(emitted.map(event => event.phase)).toEqual(['start', 'chunk', 'end']);
    expect(emitted[2]!.value).toMatchObject({ intent: { meta: { title: 'Demo' }, blocks: [{ type: 'html', props: { html: '<p>new</p>', title: 'Demo' } }] } });
  });
  it('supports direct HTML alongside task/session isolation and active assembly', async () => {
    const executor = new GenerativeUiExecutor(() => { throw new Error('unused'); });
    const first = context();
    await executor.execute(call(append('pending')), first.ctx);
    expect((await executor.execute(call({ format: 'html', code: '<b>direct</b>' }), first.ctx)).success).toBe(true);
    for (const other of [context('other', 't'), context('s', 'other')]) {
      expect((await executor.execute(call(action('complete', 1, { offset: 7 })), other.ctx)).error).toContain('revision_conflict');
    }
    expect((await executor.execute(call({ format: 'html', action: 'read', code: '', offset: 0 }), first.ctx)).output)
      .toMatchObject({ content: 'pending', revision: 1 });
    expect((await executor.execute(call(action('discard', 1)), first.ctx)).output).toMatchObject({ status: 'discarded', revision: 2 });
  });

  it('emits tool_call start/end during incremental assembly so preparing placeholders do not hang', async () => {
    const executor = new GenerativeUiExecutor(() => { throw new Error('unused'); });
    const { ctx } = context();
    const toolEvents: Array<[string, unknown]> = [];
    ctx.emitToolCallStart = (name, input, toolCallId) => { toolEvents.push(['start', { name, input, toolCallId }]); };
    ctx.emitToolCallEnd = (payload) => { toolEvents.push(['end', payload]); };

    const res = await executor.execute(call(append('<p>part 1</p>', 0, 0, { title: 'Part' })), ctx);
    expect(res.success).toBe(true);
    expect(toolEvents.map(e => e[0])).toEqual(['start', 'end']);
  });
});
