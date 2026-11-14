import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compareShapes } from './schema.ts';
import { reconcile } from './audit.ts';
import type { Site } from './scan.ts';
import { agentCompletionEnvelope } from '../../../host/plugins/chat/src/workspace-run-agent.ts';

const json = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const source = (file: string) => fs.readFileSync(file, 'utf8');
const site = (names: [string, ...string[]], shape: any, kind: Site['kind'] = 'invoke'): Site => ({ file: 'src/review-fixture.ts', line: 1, column: 1, kind, via: kind, expression: names[0], names, dynamic: false, shape, tsType: 'review-fixture', nameIndex: 0, dataIndex: 1, test: false });

test('X2-R01: integrated profile references the real F2 module, without asserting apply or invoke success', () => {
  const profile = json('host/profiles/desktop.json');
  assert(profile.plugins.some((p: any) => p.id === 'dstu.shell' && p.module === '../../electron/index.ts'));
  assert.match(source('electron/index.ts'), /ctx\.commands\.register\('get_app_version'/);
  assert.match(source('host/profiles/generate.ts'), /SHELL_PLUGINS/);
  // Static wiring assertions only. No imports of plugin apply or platform services.
});

test('X2-R02: real notes asset call supplies exact keys; extra aliases are not failed invocations', () => {
  // W09 removed the redundant snake_case aliases from the real call; the contract keys stay.
  const frontend = source('src/components/crepe/features/imageUpload.ts');
  for (const key of ['noteId', 'base64Data', 'defaultExt']) assert.match(frontend, new RegExp(`\\b${key}:`));
  for (const key of ['note_id', 'base64_data', 'default_ext']) assert.doesNotMatch(frontend, new RegExp(`\\b${key}:`));
  const doc = json('contracts/ipc/L10-notes.json');
  const command = doc.commands.find((c: any) => c.name === 'notes_save_asset');
  const shape = { type: 'object', properties: Object.fromEntries(['note_id', 'noteId', 'base64_data', 'base64Data', 'default_ext', 'defaultExt', 'subject'].map(k => [k, { type: 'string' }])), required: ['noteId', 'base64Data'] };
  const out = reconcile([site([command.name], shape)], [], { mode: 'runtime-meta', profile: '', plugins: [{ id: 'notes', file: 'host/plugins/notes/index.ts', lane: doc.lane, commands: [command.name] }] }, new Map([['L10-notes.json', { ...doc, commands: [command] }]]));
  assert.equal(out.findings.filter(f => f.code === 'argument-redundant-alias').length, 3);
  assert(!out.findings.some(f => f.code === 'argument-case-mismatch' || f.code === 'argument-missing-key'));
});

test('X2-R03: deleted notes pagination mismatch predates Host; default remains Rust pageSize=20', () => {
  // The pre-Host mismatch (frontend sent page_size, silently dropped) was fixed by W09: the call now sends pageSize.
  assert.match(source('src/utils/notesApi.ts'), /'notes_list_deleted', \{ subject: GLOBAL_SUBJECT, page, pageSize \}/);
  const command = json('contracts/ipc/L10-notes.json').commands.find((c: any) => c.name === 'notes_list_deleted');
  assert(command.args.some((a: any) => a.key === 'pageSize' && a.rustName === 'page_size' && a.optional));
  assert.match(source('host/plugins/notes/src/plugin.ts'), /'notes_list_deleted', \(\{ page, pageSize \}\)/);
});

test('X2-R29: workspace_agent_completion optional fields are omitted, not null (archived 6 mismatches are R04-class false positives)', () => {
  const doc = json('contracts/ipc/L04-chat-session.json');
  const envelope = doc.$defs.AgentCompletionEnvelope;
  for (const key of ['parent_session_id', 'task_id', 'correlation_id', 'final_output', 'error', 'token_usage']) {
    assert.equal(envelope.properties[key]['x-option'], 'omit', key);
    assert(!envelope.required.includes(key), key);
  }
  for (const key of ['parent_session_id', 'task_id', 'correlation_id', 'final_output', 'error']) {
    assert.deepEqual(compareShapes(envelope.properties[key], { type: 'string' }), [], key);
  }
  // Real serializer used by runWorkerPipeline (:672/:729), not a replica of the envelope.
  const input = {
    workspaceId: 'ws_probe', agentSessionId: 'agent_probe', runId: 'run_probe', status: 'completed' as const,
    completedAt: '2026-11-05T00:00:00Z', parentSessionId: null, taskId: null,
    correlationId: null, finalOutput: null, error: null, tokenUsage: null,
  };
  assert.deepEqual(agentCompletionEnvelope(input), {
    type: 'agent_completion', workspace_id: 'ws_probe', agent_session_id: 'agent_probe',
    run_id: 'run_probe', status: 'completed', completed_at: '2026-11-05T00:00:00Z',
  });
  assert.deepEqual(agentCompletionEnvelope({ ...input, parentSessionId: 'parent', taskId: 'task', correlationId: 'corr', finalOutput: '' }), {
    type: 'agent_completion', workspace_id: 'ws_probe', agent_session_id: 'agent_probe', parent_session_id: 'parent',
    task_id: 'task', run_id: 'run_probe', correlation_id: 'corr', status: 'completed', final_output: '', completed_at: '2026-11-05T00:00:00Z',
  });
  // The original G03 test is now ported. Preserve its exact Rust identity rather than requiring historical pending.
  const originalId = 'crates/dstu-agent/src/chat_v2/completion_dispatcher.rs::tests::g03_dedup_hit_converges_to_delivered_without_redelivery';
  const mapped = source('host/plugins/chat/TESTMAP.md').split('\n').find(row => row.includes(`\`${originalId}\``));
  assert(mapped, 'the exact original Rust test must stay accounted for');
  assert(mapped.includes('ported:host/plugins/chat/tests/completion-dispatcher.test.ts'));
  // Production assembly exists, but registration still requires L03 execute + L05/L06 surfaces (index.ts:245-258).
  assert.match(source('host/plugins/chat/src/plugin.ts'), /new CompletionDispatcherRuntime\(/);
  assert.match(source('host/plugins/chat/src/completion-dispatcher.ts'), /this\.worker\.processOne\(delivery\)/);
  assert.match(source('host/plugins/chat/src/workspace-run-agent.ts'), /dispatcher\.ensureStarted\(\)/);
});

test('X2-R04: actual Canvas skip_serializing_if fields omit null in producer direction only', () => {
  const doc = json('contracts/ipc/L10-notes.json');
  const payload = doc.$defs.CanvasAIEditRequest;
  for (const key of ['content', 'search', 'replace', 'isRegex', 'section']) {
    const schema = payload.properties[key];
    assert.equal(schema['x-option'], 'omit');
    const primitive = { type: key === 'isRegex' ? 'boolean' : 'string' };
    assert.deepEqual(compareShapes(schema, primitive), []);
    assert.deepEqual(compareShapes({ type: 'null' }, schema), []); // accepted input is not narrowed
    assert(compareShapes({ ...schema, 'x-option': 'null' }, primitive).length > 0);
  }
  assert.match(source('host/plugins/notes/src/canvas-tool.ts'), /acrBridgeCall\(bridgeCtx, 'apply_ops'/);
});

test('X2-R05: actual HEIC contract describes raw Request/Response, not an empty-args JSON command', () => {
  const doc = json('contracts/ipc/L18-media-docs.json');
  const command = doc.commands.find((c: any) => c.name === 'convert_heic_to_jpeg');
  assert.equal(command.args.length, 0);
  assert(command.injected.some((a: any) => a.kind === 'request'));
  assert.equal(command.result['x-binary'], true);
  assert.match(source('src/utils/heicConversion.ts'), /invoke<ArrayBuffer>\('convert_heic_to_jpeg', bytes\)/);
  const out = reconcile([site([command.name], { type: 'array', items: { type: 'number' } })], [], { mode: 'runtime-meta', profile: '', plugins: [] }, new Map([['L18-media-docs.json', { ...doc, commands: [command] }]]));
  assert(out.findings.some(f => f.code === 'raw-body-command' && f.severity === 'review'));
  assert(!out.findings.some(f => f.code.startsWith('argument-')));
});

test('X2-R06: macOS menu names are manually enumerable, not a wildcard emitter requirement', () => {
  const frontend = source('src/menu/menuEventBridge.ts');
  const shell = source('electron/shell/menu.ts');
  for (const name of ['preferences', 'new-session', 'command-palette', 'toggle-sidebar', 'documentation', 'report-issue']) {
    assert(frontend.includes(`menu://${name}`)); assert(shell.includes(`menu://${name}`));
  }
  assert(source('src/menu/menuEvents.ts').includes('menu://close-window'));
  assert(shell.includes('menu://close-window'));
  assert.match(shell, /click: \(\) => emit\(MENU_EVENTS\[id\]\)/);
});
