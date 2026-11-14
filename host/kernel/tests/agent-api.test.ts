import { expect, it } from 'vitest';
import { ToolDescriptor, ToolRegistryBuilder, AgentServices, ServiceKey, applyToolResultBudget, serializedCharLen, cloneAgentJson, isRawJsonAtom, type ToolProvider } from '../agent-api.ts';

const executor = (name: string) => ({ name });
type Executor = ReturnType<typeof executor>;
function provider(id: string, descriptors: ToolDescriptor[], routes: [string, Executor][], roster: Executor[], catchAll = false): ToolProvider<Executor> {
  return { id, descriptors: () => descriptors, executor: name => routes.find(([n]) => n === name)?.[1] ?? (catchAll ? roster[0] : undefined), executors: () => roster, isCatchAll: () => catchAll };
}
function simple(id: string, descriptors: ToolDescriptor[], e: Executor) { return provider(id, descriptors, descriptors.flatMap(d => d.names().map(n => [n, e] as [string, Executor])), [e]); }
const build = (...providers: ToolProvider<Executor>[]) => { const b = new ToolRegistryBuilder<Executor>(); providers.forEach(p => b.register(p)); return b.build(); };
function error(fn: () => unknown) { try { fn(); throw new Error('expected registry error'); } catch (e) { return e; } }

it('result_budget_is_noop_within_budget', () => {
  const output = { id: 'abc', content: 'short' }; expect(applyToolResultBudget(output, 30_000)).toEqual(output);
});
it('result_budget_shrinks_long_string_leaves_but_keeps_structure', () => {
  const budgeted = applyToolResultBudget({ file_id: 'file_123', success: true, content: 'x'.repeat(50_000) }, 2048);
  expect(budgeted).toMatchObject({ file_id: 'file_123', truncated: true }); expect(serializedCharLen(budgeted)).toBeLessThan(50_000);
});
const rawJSON = (text: string) => (JSON as typeof JSON & { rawJSON(text: string): unknown }).rawJSON(text);
it('clone_agent_json_shares_raw_atoms_and_copies_containers', () => {
  const atom = rawJSON('1.0');
  const args = { limit: atom, nested: { list: [atom, 'x', 2] } };
  expect(() => structuredClone(args)).toThrow();
  const copy = cloneAgentJson(args);
  expect(copy).not.toBe(args); expect(copy.nested).not.toBe(args.nested); expect(copy.nested.list).not.toBe(args.nested.list);
  expect(copy.limit).toBe(atom); expect(copy.nested.list[0]).toBe(atom);
  expect(JSON.stringify(copy)).toBe('{"limit":1.0,"nested":{"list":[1.0,"x",2]}}');
  copy.nested.list.push('mutated'); expect(args.nested.list).toHaveLength(3);
});
it('clone_agent_json_keeps_structured_clone_semantics_for_other_values', () => {
  const cyclic: Record<string, unknown> = { when: new Date(0), bytes: new Uint8Array([1, 2]) }; cyclic.self = cyclic;
  const copy = cloneAgentJson(cyclic);
  expect(copy.self).toBe(copy); expect(copy.when).toEqual(new Date(0)); expect(copy.when).not.toBe(cyclic.when);
  expect(copy.bytes).toEqual(new Uint8Array([1, 2])); expect(copy.bytes).not.toBe(cyclic.bytes);
  const proto = cloneAgentJson({ ['__proto__']: { polluted: true } } as Record<string, unknown>);
  expect(Object.getPrototypeOf(proto)).toBe(Object.prototype); expect(Object.keys(proto)).toEqual(['__proto__']);
  expect(() => cloneAgentJson({ run: () => 1 })).toThrow(/could not be cloned/);
  expect(() => cloneAgentJson([Symbol('s')])).toThrow(/could not be cloned/);
});
it('raw_atom_check_rejects_business_objects_with_a_raw_json_key', () => {
  expect(isRawJsonAtom(rawJSON('1e2'))).toBe(true);
  const lookalike = { rawJSON: '1.0' };
  expect(isRawJsonAtom(lookalike)).toBe(false);
  expect(cloneAgentJson(lookalike)).not.toBe(lookalike); expect(JSON.stringify(cloneAgentJson(lookalike))).toBe('{"rawJSON":"1.0"}');
});
it('descriptor_names_include_primary_and_aliases_in_order', () => {
  const d = new ToolDescriptor('workspace_file_read').withAliases(['builtin-workspace_file_read', 'workspace_workspace_file_read']);
  expect(d.names()).toEqual(['workspace_file_read', 'builtin-workspace_file_read', 'workspace_workspace_file_read']);
});
it('descriptor_defaults_are_conservative', () => {
  expect(new ToolDescriptor('demo')).toMatchObject({ blockType: 'mcp_tool', timeout: null, headless: 'blocked', ptc: 'denied', sensitivity: 'low', approval: { kind: 'scoped' } });
});
it('duplicate_tool_name_across_providers_fails_with_conflict', () => {
  const shared = executor('shared_tool');
  const e = error(() => build(simple('first', [new ToolDescriptor('shared_tool')], shared), simple('second', [new ToolDescriptor('shared_tool')], shared)));
  expect(e).toMatchObject({ code: 'DuplicateToolName', fields: { name: 'shared_tool', first: 'first', second: 'second' } }); expect(String(e)).toContain('shared_tool');
});
it('duplicate_alias_across_providers_fails_with_conflict', () => {
  const e = error(() => build(simple('first', [new ToolDescriptor('note_read').withAliases(['builtin-note_read'])], executor('note_read')), simple('second', [new ToolDescriptor('other_tool').withAliases(['builtin-note_read'])], executor('other_tool'))));
  expect(e).toMatchObject({ code: 'DuplicateToolName', fields: { name: 'builtin-note_read' } });
});
it('descriptor_without_executor_fails', () => {
  expect(error(() => build(provider('broken', [new ToolDescriptor('missing_tool')], [], [executor('missing_tool')])))).toMatchObject({ code: 'MissingExecutor', fields: { provider: 'broken', name: 'missing_tool' } });
});
it('executor_missing_from_roster_fails', () => {
  expect(error(() => build(provider('drifting', [new ToolDescriptor('noted_tool')], [['noted_tool', executor('noted_tool')]], [executor('something_else')])))).toMatchObject({ code: 'ExecutorNotInRoster', fields: { provider: 'drifting', name: 'noted_tool' } });
});
it('undeclared_executor_in_non_catch_all_provider_fails', () => {
  const noted = executor('noted_tool');
  expect(error(() => build(provider('overreaching', [new ToolDescriptor('noted_tool')], [['noted_tool', noted]], [noted, executor('rogue_tool')])))).toMatchObject({ code: 'UndeclaredExecutor', fields: { provider: 'overreaching' } });
});
it('duplicate_catch_all_provider_fails', () => {
  const general = executor('general');
  expect(error(() => build(provider('general_first', [new ToolDescriptor('general')], [['general', general]], [general], true), provider('general_second', [], [], [general], true)))).toMatchObject({ code: 'MultipleCatchAllProviders', fields: { first: 'general_first', second: 'general_second' } });
});
it('catch_all_provider_must_be_last', () => {
  expect(error(() => build(provider('general', [], [], [executor('general')], true), simple('later', [new ToolDescriptor('later_tool')], executor('later_tool'))))).toMatchObject({ code: 'CatchAllNotLast', fields: { provider: 'general', after: 'later' } });
});
it('provider_order_and_roster_order_are_preserved', () => {
  const meta = executor('meta_tool'), alpha = executor('alpha_tool');
  const registry = build(simple('first', [new ToolDescriptor('meta_tool')], meta), simple('second', [new ToolDescriptor('alpha_tool'), new ToolDescriptor('beta_tool')], alpha));
  expect(registry.executors()).toHaveLength(2); expect(registry.executors()[0]).toBe(meta); expect(registry.executors()[1]).toBe(alpha);
  expect(registry.providers().map(p => p.id)).toEqual(['first', 'second']); expect(registry.ownerOf('meta_tool')).toBe('first'); expect(registry.ownerOf('alpha_tool')).toBe('second'); expect(registry.len()).toBe(3);
});
it('registry_resolves_names_aliases_and_catch_all', () => {
  const note = executor('note_read'), general = executor('general');
  const registry = build(simple('notes', [new ToolDescriptor('note_read').withAliases(['builtin-note_read'])], note), provider('general', [], [], [general], true));
  expect(registry.executorFor('note_read')).toBe(note); expect(registry.executorFor('builtin-note_read')).toBe(note); expect(registry.descriptor('builtin-note_read')?.name).toBe('note_read');
  expect(registry.executorFor('mcp_unknown_tool')).toBe(general); expect(registry.descriptor('mcp_unknown_tool')).toBeUndefined(); expect(registry.catchAllProvider()).toBeDefined(); expect(registry.ownerOf('mcp_unknown_tool')).toBeUndefined();
});
it('duplicate_provider_id_fails', () => {
  expect(error(() => build(simple('same_id', [new ToolDescriptor('a_tool')], executor('a_tool')), simple('same_id', [new ToolDescriptor('b_tool')], executor('b_tool'))))).toMatchObject({ code: 'DuplicateProviderId', fields: { provider: 'same_id' } });
});
it('empty_registry_fails', () => { expect(error(() => build())).toMatchObject({ code: 'EmptyRegistry' }); });
it('empty_descriptor_name_fails', () => {
  expect(error(() => build(provider('empty', [new ToolDescriptor('  ')], [['  ', executor('  ')]], [executor('  ')])))).toMatchObject({ code: 'EmptyToolName', fields: { provider: 'empty' } });
});
it('builder_does_not_require_concrete_executors', () => {
  const e = executor('demo_tool'); const builder = new ToolRegistryBuilder<Executor>(); builder.register(simple('demo', [new ToolDescriptor('demo_tool')], e));
  expect(builder.build().executorFor('demo_tool')).toBe(e);
});
const DemoDb = new ServiceKey<number>('DemoDb'), OtherDb = new ServiceKey<string>('OtherDb');
it('insert_get_and_require_round_trip', () => {
  const services = new AgentServices(); expect(services.isEmpty()).toBe(true); expect(services.insert(DemoDb, 7)).toBeUndefined();
  expect(services.len()).toBe(1); expect(services.contains(DemoDb)).toBe(true); expect(services.get(DemoDb)).toBe(7); expect(services.require(DemoDb)).toBe(7);
});
it('require_reports_missing_type_name', () => {
  const e = error(() => new AgentServices().require(OtherDb)); expect(e).toMatchObject({ typeName: 'OtherDb' }); expect(String(e)).toContain('OtherDb');
});
it('insert_replaces_same_type_without_touching_others', () => {
  const services = new AgentServices(); services.insert(DemoDb, 1); services.insert(OtherDb, 'other');
  expect(services.insert(DemoDb, 2)).toBe(1); expect(services.get(DemoDb)).toBe(2); expect(services.get(OtherDb)).toBe('other'); expect(services.len()).toBe(2);
});
