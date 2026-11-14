import { test } from 'vitest';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanProgram, shellRoutes, type Site } from './scan.ts';
import { compareShapes, resolveSchema } from './schema.ts';
import { reconcile, matches, classifyDynamic } from './audit.ts';

function fixtureProgram(source: string, extra: Record<string, string> = {}) {
  const root = '/frontend-audit-fixture';
  const files: Record<string, string> = {
    [`${root}/src/input.ts`]: source,
    [`${root}/src/tauri.d.ts`]: `declare module '@tauri-apps/api/core' {
      export function invoke<T>(cmd: string, args?: object): Promise<T>;
    }
    declare module '@tauri-apps/api/event' {
      export function listen<T>(name: string, handler: (event: { payload: T }) => void): Promise<() => void>;
      export function once<T>(name: string, handler: (event: { payload: T }) => void): Promise<() => void>;
      export function emit(name: string, payload?: unknown): Promise<void>;
      export function emitTo(target: string, name: string, payload?: unknown): Promise<void>;
    }`,
    ...Object.fromEntries(Object.entries(extra).map(([f, text]) => [`${root}/${f}`, text])),
  };
  const host = ts.createCompilerHost({});
  const originalRead = host.readFile, originalExists = host.fileExists;
  const originalDirectory = host.directoryExists;
  host.readFile = f => files[f] ?? originalRead(f);
  host.fileExists = f => f in files || originalExists(f);
  host.directoryExists = d => Object.keys(files).some(f => f.startsWith(d + '/')) || !!originalDirectory?.(d);
  const originalGet = host.getSourceFile;
  host.getSourceFile = (f, lang, onError, create) => {
    const text = files[f];
    return text === undefined ? originalGet(f, lang, onError, create) : ts.createSourceFile(f, text, lang, true);
  };
  return { program: ts.createProgram(Object.keys(files), { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, strictNullChecks: true }, host), root };
}

function scan(source: string, extra: Record<string, string> = {}) {
  const { program, root } = fixtureProgram(source, extra);
  return scanProgram(program, root);
}

function siteAt(out: ReturnType<typeof scan>, index: number): Site {
  const site = out.sites[index];
  assert(site, `fixture must produce site ${index}`);
  return site;
}

test('AST aliases, namespace, literal unions, emit/once and inferred payload keys', () => {
  const out = scan(`import { invoke as send } from '@tauri-apps/api/core';
    import * as events from '@tauri-apps/api/event';
    const cmd = true ? 'alpha' : 'beta';
    send(cmd, { sessionId: 's', count: 1 });
    events.once<{ done: boolean }>('finished', e => {});
    events.emit('ui-event', { count: 1 });
    const local = { emit(x: string) {} }; local.emit('not-ipc');`);
  assert.equal(out.sites.length, 3);
  assert.deepEqual(siteAt(out, 0).names, ['alpha', 'beta']);
  assert.deepEqual(Object.keys(siteAt(out, 0).shape.properties), ['sessionId', 'count']);
  assert.equal(siteAt(out, 1).shape.properties.done.type, 'boolean');
  assert.equal(siteAt(out, 2).kind, 'emit');
  assert.equal(out.candidates.length, 1);
});

test('fixed point derives wrapper parameter positions, does not double count forwards', () => {
  const out = scan(`import { invoke } from '@tauri-apps/api/core';
    function inner(args: { itemId: string }, command: string) { return invoke(command, args); }
    function outer(tag: string, cmd: string, data: { itemId: string }) { return inner(data, cmd); }
    outer('debug', 'get_item', { itemId: 'id' });`);
  assert.equal(out.wrappers.length, 2);
  assert.deepEqual(out.wrappers.find(w => w.name === 'outer') && [out.wrappers.find(w => w.name === 'outer')!.nameIndex, out.wrappers.find(w => w.name === 'outer')!.dataIndex], [1, 2]);
  assert.equal(out.forwarding.length, 2);
  assert.equal(out.sites.length, 1);
  assert.deepEqual(siteAt(out, 0).names, ['get_item']);
  assert.equal(siteAt(out, 0).shape.properties.itemId.type, 'string');
});

test('dynamic import destructuring and event templates resolve constants', () => {
  const out = scan(`async function run(id: string) {
    const { invoke: call } = await import('@tauri-apps/api/core');
    const events = await import('@tauri-apps/api/event');
    const name = 'load'; call(name, { id });
    const channel = \`chat_v2_event_\${id}\`;
    events.listen<{ sequenceId: number }>(channel, e => {});
  }`);
  assert.equal(out.sites.length, 2);
  assert.deepEqual(siteAt(out, 0).names, ['load']);
  assert.deepEqual(siteAt(out, 1).names, ['chat_v2_event_{}']);
  assert.equal(siteAt(out, 1).dynamic, true);
  assert.match(classifyDynamic(siteAt(out, 1)), /事件通道/);
});

test('fixed API command is counted once internally; tests are kept but tagged', () => {
  const out = scan(`import { invoke } from '@tauri-apps/api/core';
    function getItem(id: string) { return invoke('get_item', { itemId: id }); }
    getItem('a'); getItem('b');`, { 'src/example.test.ts': `import { invoke } from '@tauri-apps/api/core'; invoke('fake');` });
  assert.equal(out.sites.length, 2);
  assert.equal(out.sites.filter(s => s.test).length, 1);
});

test('shape comparison resolves refs, checks nested names, preserves unknown', () => {
  const doc = { $defs: { Payload: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] } } };
  const deref = (s: any) => resolveSchema(s, doc, new Map());
  assert.deepEqual(compareShapes({ type: 'object', properties: { taskId: { type: 'string' } } }, { $ref: '#/$defs/Payload' }, 'payload', deref), [{ path: 'payload.task_id', reason: 'missing required field' }]);
  assert.equal(compareShapes({ 'x-ts': 'any' }, { type: 'object', required: ['id'] }).length, 0);
  assert.equal(compareShapes({ type: 'integer' }, { type: 'number' }).length, 0);
  assert.equal(compareShapes({ type: 'string' }, { anyOf: [{ type: 'null' }, { type: 'string' }] }).length, 0);
});

const site = (overrides: Partial<Site>): Site => ({ file: 'src/a.ts', line: 1, column: 1, kind: 'invoke', via: 'invoke', expression: "'load'", names: ['load'], dynamic: false, shape: { type: 'object', properties: {}, required: [] }, tsType: '{}', nameIndex: 0, dataIndex: 1, test: false, ...overrides });

test('three-way reconciliation: Tauri case is exact, top-level extras are ignored, nested fields not converted', () => {
  const doc = { lane: 'L-test', commands: [{ name: 'load', args: [{ key: 'sessionId', rustName: 'session_id', optional: false, schema: { type: 'string' } }, { key: 'request', rustName: 'request', optional: false, schema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] } }] }] };
  const out = reconcile([site({ shape: { type: 'object', properties: { session_id: { type: 'string' }, ignored: { type: 'number' }, request: { type: 'object', properties: { taskId: { type: 'string' } } } } } })], [], { mode: 'runtime-meta', profile: '', plugins: [{ id: 'p', file: 'host/p.ts', lane: 'L-test', commands: ['load', 'new_command'] }] }, new Map([['test.json', doc]]));
  assert(out.findings.some(f => f.code === 'argument-case-mismatch' && f.detail.startsWith('session_id != sessionId')));
  assert(out.findings.some(f => f.code === 'argument-missing-key'));
  assert(out.findings.some(f => f.code === 'argument-extra-key' && f.severity === 'review'));
  assert(out.findings.some(f => f.code === 'argument-shape-mismatch' && f.detail.startsWith('request.task_id')));
  assert.equal(out.stats.hostCommandsMissingContract, 1);
  assert.equal(out.stats.frontendCommandsMissingHostMeta, 0);
});

test('events match dynamic channels and report payload fields rather than renaming them', () => {
  assert(matches('chat_{}', 'chat_session-1'));
  assert(matches('chat_{}', 'chat_{}'));
  assert(!matches('chat_{}', 'other_session-1'));
  const out = reconcile([site({ kind: 'listen', names: ['chat_{}'], dynamic: true, shape: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] } })], [], { mode: 'runtime-meta', profile: '', plugins: [] }, new Map([['events.json', { lane: 'L-chat', events: [{ name: 'chat_{}', payload: { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'] } }] }]]));
  assert.equal(out.stats.matchedEventNames, 1);
  assert(out.findings.some(f => f.code === 'event-payload-mismatch' && f.detail.startsWith('payload.sessionId')));
  assert(out.findings.some(f => f.code === 'host-event-emitter-unproven' && f.severity === 'review'));
});

test('failed Host module imports block the audit and do not manufacture coverage', () => {
  const out = reconcile([site({})], [], { mode: 'runtime-meta', profile: '', plugins: [{ id: 'p', file: 'host/p.ts', lane: 'HOST-LOAD', commands: [], error: 'missing dependency' }] }, new Map());
  assert.equal(out.stats.failedPlugins, 1);
  assert.equal(out.stats.frontendCommandsInHostMeta, 0);
  assert(out.findings.some(f => f.code === 'host-load-failed'));
  assert(out.findings.some(f => f.code === 'frontend-command-not-in-host-meta' && f.detail.includes('failed imports')));
});

test('reviewed eventHub indirection uses keyed handler position and raw payload', () => {
  const out = scan('', { 'src/features/workbench/core/eventHub.ts': `
    export function hubListenKeyed<T>(eventName: string, key: string, handler: (payload: T) => void) {}
    hubListenKeyed<{ session_id: string }>('session-changed', 's', payload => {});` });
  assert.equal(out.sites.length, 1);
  assert.equal(siteAt(out, 0).kind, 'listen');
  assert.equal(siteAt(out, 0).dataIndex, 2);
  assert.equal(siteAt(out, 0).shape.properties.session_id.type, 'string');
});

test('runtime metadata probe imports a real module without calling apply', () => {
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./registry.ts', import.meta.url)), '--probe', fileURLToPath(new URL('./fixtures/metadata.ts', import.meta.url))], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const meta = JSON.parse(child.stdout.trim().slice('FRONTEND_AUDIT_META='.length));
  assert.deepEqual(meta.commands, ['fixture_load']);
  assert.equal(meta.lane, 'X2-test');
});

test('cross-module wrapper import aliases and method wrappers retain inferred offsets', () => {
  const out = scan(`import { send as remote } from './wrapper';
    remote({ itemId: 's' }, 'load_item');`, { 'src/wrapper.ts': `
    import { invoke } from '@tauri-apps/api/core';
    export function send(data: { itemId: string }, name: string) { return invoke(name, data); }` });
  assert.equal(out.sites.length, 1);
  assert.deepEqual(siteAt(out, 0).names, ['load_item']);
  assert.equal(siteAt(out, 0).nameIndex, 1);
  assert.equal(out.forwarding.length, 1);
});

test('explicit snake_case command contract is accepted unchanged; raw Request body is not a keys object', () => {
  const out = reconcile([
    site({ names: ['snake'], shape: { type: 'object', properties: { session_id: { type: 'string' } } } }),
    site({ names: ['binary'], shape: { type: 'array', items: { type: 'number' } } }),
  ], [], { mode: 'runtime-meta', profile: '', plugins: [] }, new Map([['snake.json', { lane: 'L-test', commands: [
    { name: 'snake', args: [{ key: 'session_id', rustName: 'session_id', schema: { type: 'string' } }] },
    { name: 'binary', args: [], injected: [{ kind: 'request' }] },
  ] }]]));
  assert(!out.findings.some(f => f.code.startsWith('argument-')));
  assert(out.findings.some(f => f.code === 'raw-body-command' && f.severity === 'review'));
});

test('frontend emitTo skips target and extracts the event name and payload', () => {
  const out = scan(`import { emitTo as publish } from '@tauri-apps/api/event';
    publish('main', 'open-target', { path: '/document' });`);
  assert.equal(out.sites.length, 1);
  assert.deepEqual(siteAt(out, 0).names, ['open-target']);
  assert.equal(siteAt(out, 0).shape.properties.path.type, 'string');
  assert.equal(siteAt(out, 0).kind, 'emit');
});

test('optional Rust event field does not satisfy a required frontend payload field', () => {
  assert.deepEqual(compareShapes(
    { type: 'object', properties: { id: { type: 'string' } }, required: [] },
    { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, 'payload'),
  [{ path: 'payload.id', reason: 'field may be omitted by source' }]);
});

test('bare unknown event does not match every backend event', () => {
  assert(!matches('{}', 'known'));
  const out = reconcile([site({ kind: 'listen', names: ['{}'], dynamic: true })], [], { mode: 'runtime-meta', profile: '', plugins: [] }, new Map([['e.json', { lane: 'L-test', events: [{ name: 'known', payload: { type: 'string' } }] }]]));
  assert.equal(out.stats.matchedEventNames, 0);
  assert(!out.findings.some(f => f.code === 'event-payload-mismatch'));
  assert(out.findings.some(f => f.code === 'event-name-unresolved'));
});

test('lazy import then callbacks, cached transport factories and injected invoke aliases are scanned', () => {
  const out = scan(`
    import('@tauri-apps/api/event').then(({ listen, emit }) => { listen('request', e => {}); emit('response', {}); });
    async function getListen() { return import('@tauri-apps/api/event').then(m => m.listen); }
    async function setup() { const listen = await getListen(); listen('cached-listen', e => {}); }
    type InjectedInvoke = (command: string) => Promise<unknown>;
    function run(invoke: InjectedInvoke) { invoke('injected'); }`);
  assert.deepEqual(out.sites.flatMap(s => s.names).sort(), ['cached-listen', 'injected', 'request', 'response']);
});

test('literal command tables and pure event name builders are expanded', () => {
  const out = scan(`import { invoke } from '@tauri-apps/api/core'; import { listen } from '@tauri-apps/api/event';
    const table: Record<string, string> = { pause: 'pause_task', resume: 'resume_task' };
    function channel(id: string): string { return \`chat_\${id}\`; }
    function run(action: string, id: string) { invoke(table[action]); listen(channel(id), e => {}); }`);
  assert.deepEqual(siteAt(out, 0).names, ['pause_task', 'resume_task']);
  assert.deepEqual(siteAt(out, 1).names, ['chat_{}']);
});

test('wrappers with bound args and transformed payloads preserve command callsites', () => {
  const out = scan(`import { invoke } from '@tauri-apps/api/core';
    function bound(name: string) { return invoke(name, { older_than_days: 3 }); }
    function withLease(name: string, args: Record<string, unknown>) { return invoke(name, { ...args, lease: 'x' }); }
    bound('optimize'); withLease('save', { noteId: 'n' });`);
  assert.equal(out.sites.length, 2);
  assert.equal(siteAt(out, 0).shape.properties.older_than_days.type, 'number');
  assert.equal(siteAt(out, 1).shape['x-open'], true);
  assert(out.wrappers.some(w => w.name === 'bound' && w.dataIndex === -1));
});

test('external shared refs keep their owning document for nested local refs', () => {
  const shared = { $defs: {
    Outer: { type: 'object', properties: { inner: { $ref: '#/$defs/Inner' } }, required: ['inner'] },
    Inner: { type: 'string' },
  } };
  const source = { type: 'object', properties: { inner: { type: 'number' } }, required: ['inner'] };
  const problems = compareShapes(source, { $ref: '_shared.json#/$defs/Outer' }, 'request', s => resolveSchema(s, {}, new Map([['_shared.json', shared]])));
  assert.deepEqual(problems, [{ path: 'request.inner', reason: 'type number -> string' }]);
});

test('kernel registrations and Electron static routes are not falsely reported missing', () => {
  const out = reconcile([site({ names: ['plugin:host|call'] }), site({ names: ['plugin:clipboard-manager|read_text'] })], [], {
    mode: 'runtime-meta', profile: '',
    plugins: [{ id: 'kernel', file: 'host/kernel/runtime.ts', lane: 'F1-kernel', commands: ['plugin:host|call'], basis: 'kernel-registration' }],
    shellRoutes: [{ command: 'plugin:clipboard-manager|read_text', file: 'electron/shell/plugins/system.ts', line: 39 }],
  }, new Map());
  assert.equal(out.stats.frontendCommandsMissingHostMeta, 0);
  assert.equal(out.stats.errors, 0);
  assert.equal(out.stats.review, 0);
  assert.equal(out.stats.kernelCommandsActuallyRegistered, 1);
});

test('redundant snake/camel pairs are ignored extra aliases, not invalid calls', () => {
  const out = reconcile([site({ names: ['load'], shape: { type: 'object', properties: { sessionId: { type: 'string' }, session_id: { type: 'string' } }, required: ['sessionId', 'session_id'] } })], [], { mode: 'runtime-meta', profile: '', plugins: [] }, new Map([['c.json', { lane: 'L-test', commands: [{ name: 'load', args: [{ key: 'sessionId', rustName: 'session_id', schema: { type: 'string' } }] }] }]]));
  assert(out.findings.some(f => f.code === 'argument-redundant-alias' && f.severity === 'review'));
  assert(!out.findings.some(f => f.code === 'argument-case-mismatch'));
});

test('Shell registerPlugin factory return keys are read without entering nested handlers', () => {
  const { program, root } = fixtureProgram('', {
    'electron/main.ts': `import { clipboard } from './factory'; runtime.registerPlugin('clipboard-manager', clipboard());`,
    'electron/factory.ts': `export function clipboard() { return { read_text: () => '', write_text: () => { return { not_a_command: 1 }; } }; }`,
  });
  assert.deepEqual(shellRoutes(program, root).map(r => r.command), ['plugin:clipboard-manager|read_text', 'plugin:clipboard-manager|write_text']);
});

test('Host handler comparison accounts for kernel materialization of optional argument keys', () => {
  const nullable = { anyOf: [{ type: 'number' }, { type: 'null' }] };
  const out = reconcile([site({ names: ['load'] })], [site({ file: 'host/p.ts', kind: 'register', names: ['load'], shape: { type: 'object', properties: { limit: nullable }, required: ['limit'] } })], { mode: 'runtime-meta', profile: '', plugins: [] }, new Map([['c.json', { lane: 'L-test', commands: [{ name: 'load', args: [{ key: 'limit', rustName: 'limit', optional: true, schema: nullable }] }] }]]));
  assert(!out.findings.some(f => f.code === 'host-handler-shape-mismatch'));
});

test('loop command tables enumerate every element instead of folding the first synthetic property', () => {
  const out = scan(`import { invoke } from '@tauri-apps/api/core';
    const tasks = [{ command: 'chat_optimize' }, { command: 'vfs_optimize' }];
    for (const task of tasks) invoke(task.command);
    let runtimeName = 'initial'; runtimeName = 'changed'; invoke(runtimeName);`);
  assert.deepEqual(siteAt(out, 0).names, ['chat_optimize', 'vfs_optimize']);
  assert.equal(siteAt(out, 1).dynamic, true);
});

test('optional empty-args branch does not erase a wrapper forwarding branch', () => {
  const out = scan(`import { invoke } from '@tauri-apps/api/core';
    function browser(name: string, args?: Record<string, unknown>) { return args === undefined ? invoke(name) : invoke(name, args); }
    browser('open', { url: 'https://example.com' });`);
  assert.equal(out.sites.length, 1);
  assert.equal(siteAt(out, 0).dataIndex, 1);
  assert.equal(siteAt(out, 0).shape.properties.url.type, 'string');
});

test('cast transport aliases and default injected parameter names retain IPC provenance', () => {
  const out = scan(`import { invoke } from '@tauri-apps/api/core';
    type InvokeLike = (command: string, args?: object) => Promise<unknown>;
    const defaultInvoke = invoke as unknown as InvokeLike;
    function load(invokeFn: InvokeLike = defaultInvoke) { return invokeFn('load_source', { id: 'x' }); }
    const direct = invoke; direct('direct_call');`);
  assert.deepEqual(out.sites.flatMap(s => s.names).sort(), ['direct_call', 'load_source']);
});
