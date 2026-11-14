import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { applyBaseline, judge, loadCommandContracts, openArgSites, run, scanFile, scanSources, type ContractCommand, type Finding } from './frontend-invoke.mjs';

const contracts = new Map<string, ContractCommand>([
  ['notes_list_deleted', { name: 'notes_list_deleted', args: [{ key: 'subject', optional: true }, { key: 'page', optional: true }, { key: 'pageSize', optional: true }] }],
  ['get_image_as_base64', { name: 'get_image_as_base64', args: [{ key: 'relativePath', optional: false }] }],
  ['notes_editor_flush', { name: 'notes_editor_flush', args: [{ key: 'lease', optional: false }, { key: 'noteId', optional: false }] }],
  ['staged_upload_append', { name: 'staged_upload_append', args: [], injected: [{ kind: 'request' }] }],
  ['pause_task', { name: 'pause_task', args: [{ key: 'documentId', optional: false }] }],
  ['resume_task', { name: 'resume_task', args: [{ key: 'documentId', optional: false }] }],
]);
const rules = (findings: Finding[]) => findings.map((f) => [f.rule, f.command ?? f.function, f.key]);
const check = (text: string, file = 'src/a.ts') => judge(scanFile(file, text), contracts);
const TAURI = "import { invoke } from '@tauri-apps/api/core';\n";

describe('frontend-invoke gate: scanning and judging', () => {
  it('flags unknown commands, unknown keys and missing required keys on literal invokes', () => {
    expect(rules(check(`${TAURI}invoke('nope_cmd'); invoke('notes_list_deleted', { page, page_size: 20 }); invoke('get_image_as_base64', { relative_path: p });`))).toEqual([
      ['unknown-command', 'nope_cmd', null],
      ['unknown-arg', 'notes_list_deleted', 'page_size'],
      ['unknown-arg', 'get_image_as_base64', 'relative_path'],
      ['missing-required', 'get_image_as_base64', 'relativePath'],
    ]);
  });

  it('spreads keep extra-key checks but suppress missing-required (key set unknown)', () => {
    expect(rules(check(`${TAURI}invoke('get_image_as_base64', { ...base, relative_path: p });`))).toEqual([['unknown-arg', 'get_image_as_base64', 'relative_path']]);
    expect(rules(check(`${TAURI}invoke('get_image_as_base64', { ...(ok ? { relativePath } : {}) });`))).toEqual([]);
    expect(rules(check(`${TAURI}invoke('get_image_as_base64', args);`))).toEqual([]);
  });

  it('follows import aliases, conditional aliases, parameter defaults and member calls', () => {
    const text = `import { invoke as tauriInvoke } from '@tauri-apps/api/core';
const invoke = isTauri ? tauriInvoke : null;
export function f(invokeFn = tauriInvoke) { invokeFn('nope_a'); }
invoke('nope_b');
TauriAPI.invoke('nope_c');`;
    expect(rules(check(text)).map((r) => r[1])).toEqual(['nope_a', 'nope_b', 'nope_c']);
  });

  it('a local helper that merely happens to be named invoke is not an IPC call', () => {
    const text = `const invoke = (id) => (ctx) => run(ctx, id);\nitem.onRun = invoke(commandId);\nconst invokeVfsResolve = (refs) => refs;\ninvokeVfsResolve(refs);`;
    expect(scanFile('src/menu.ts', text)).toEqual([]);
  });

  it('detects forwarding wrappers (also wrappers of wrappers, and across files via import)', () => {
    const lib = `${TAURI}export async function invokeWithDebug(cmd, args) { return invoke(cmd, args); }
export async function tauriInvoke(cmd, args) { return invokeWithDebug(cmd, args); }`;
    const user = `import { tauriInvoke } from './lib';\ntauriInvoke('notes_list_deleted', { pageSize: 1, page_size: 1 });`;
    const sites = scanSources([{ file: 'src/lib.ts', text: lib }, { file: 'src/user.ts', text: user }]);
    expect(sites.filter((s) => s.dynamic).map((s) => s.function)).toEqual(['invokeWithDebug', 'tauriInvoke']);
    expect(rules(judge(sites, contracts)).filter((r) => r[0] !== 'dynamic-command')).toEqual([['unknown-arg', 'notes_list_deleted', 'page_size']]);
  });

  it('files that never mention invoke are still scanned once they mention a detected wrapper (chains, methods, \\u-escaped names)', () => {
    const sites = scanSources([
      { file: 'src/e.ts', text: `api.request('nope_e', { x: 1 });` },
      { file: 'src/c.ts', text: `import { relay } from './b';\nrelay('nope_c');` },
      { file: 'src/f.ts', text: `import { \\u0073end } from './a';\n\\u0073end('nope_f');` },
      { file: 'src/g.ts', text: `foo('nope_g'); sender('nope_g2'); x.requests('nope_g3');` },
      { file: 'src/d.ts', text: `import { relay } from './b';\nclass Api { request(cmd, args) { return relay(cmd, args); } }` },
      { file: 'src/b.ts', text: `import { send } from './a';\nexport const relay = (cmd, args) => send(cmd, args);` },
      { file: 'src/a.ts', text: `${TAURI}export function send(cmd, args) { return invoke(cmd, args); }` },
    ]);
    expect(sites.map((s) => [s.file, s.callee, s.dynamic ? s.function : s.command])).toEqual([
      ['src/e.ts', 'request', 'nope_e'],
      ['src/c.ts', 'relay', 'nope_c'],
      ['src/f.ts', 'send', 'nope_f'],
      ['src/d.ts', 'relay', 'request'],
      ['src/b.ts', 'send', 'relay'],
      ['src/a.ts', 'invoke', 'send'],
    ]);
  });

  it('resolves scoped consts and lookup tables; truly dynamic names are dynamic-command', () => {
    const text = `${TAURI}const COMMAND_BY_ACTION = { pause: 'pause_task', resume: 'resume_task' } as const;
async function control(action) { await invoke(COMMAND_BY_ACTION[action], { document_id: id }); }
async function other(name) { const cmd = flag ? 'pause_task' : 'resume_task'; await invoke(cmd, { documentId }); await invoke(\`x_\${name}\`); }`;
    expect(rules(check(text))).toEqual([
      ['unknown-arg', 'pause_task', 'document_id'], ['missing-required', 'pause_task', 'documentId'],
      ['unknown-arg', 'resume_task', 'document_id'], ['missing-required', 'resume_task', 'documentId'],
      ['dynamic-command', 'other', null],
    ]);
  });

  it('literal commands whose argument object is not a fully literal object are listed for manual review, not as findings', () => {
    const text = `${TAURI}invoke('get_image_as_base64', payload);
invoke('notes_list_deleted', { ...filters, page: 1 });
invoke('notes_list_deleted', { page: 1 });
invoke('notes_list_deleted');
invoke(dyn, payload);
invoke('staged_upload_append', chunk);`;
    const sites = scanFile('src/a.ts', text);
    expect(openArgSites(sites, contracts)).toEqual([
      { file: 'src/a.ts', line: 2, function: '<module>', command: 'get_image_as_base64', keys: [] },
      { file: 'src/a.ts', line: 3, function: '<module>', command: 'notes_list_deleted', keys: ['page'] },
    ]);
    expect(rules(judge(sites, contracts))).toEqual([['dynamic-command', '<module>', null]]);
  });

  it('raw Request commands skip key checks; invokeWithLease supplies lease', () => {
    const text = `${TAURI}class C { async invokeWithLease(command, args) { return invoke(command, { ...args, lease }); }
  async flush(noteId) { await this.invokeWithLease('notes_editor_flush', { noteId }); } }
invoke('staged_upload_append', { uploadId, offset, data });`;
    expect(rules(check(text))).toEqual([['dynamic-command', 'invokeWithLease', null]]);
  });
});

describe('frontend-invoke gate: baseline ratchet', () => {
  const f = (rule: Finding['rule'], command: string | null, key: string | null = null, fn = 'g'): Finding => ({ rule, file: 'src/a.ts', line: 1, function: fn, command, key, message: '' });

  it('counts per key: occurrences beyond the baseline count are new errors; missing ones are stale info', () => {
    const baseline = { entries: [{ rule: 'unknown-command' as const, file: 'src/a.ts', command: 'dead', count: 1 }, { rule: 'dynamic-command' as const, file: 'src/a.ts', function: 'wrap', count: 1 }] };
    const { fresh, stale } = applyBaseline([f('unknown-command', 'dead'), f('unknown-command', 'dead'), f('unknown-arg', 'x', 'k')], baseline);
    expect(fresh.map((x) => [x.rule, x.command, x.severity])).toEqual([['unknown-command', 'dead', 'error'], ['unknown-arg', 'x', 'error']]);
    expect(stale.map((x) => [x.rule, x.function, x.present, x.severity])).toEqual([['dynamic-command', 'wrap', 0, 'info']]);
  });
});

describe('frontend-invoke gate: real tree', () => {
  const roots: string[] = [];
  afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
  const repo = path.resolve(import.meta.dirname, '../../..');

  it('contracts include F1 hostNative kernel commands', () => {
    const c = loadCommandContracts(repo);
    for (const n of ['plugin:ui|manifest', 'plugin:host|call', 'plugin:host|status']) expect(c.has(n)).toBe(true);
  });

  it('current src/ has no findings beyond the checked-in baseline, and a new bad call is caught', () => {
    const result = run({ root: repo });
    expect(result.summary.fresh).toBe(0);
    expect(result.summary.stale).toBe(0);

    const root = mkdtempSync(path.join(tmpdir(), 'w09-frontend-invoke-'));
    roots.push(root);
    cpSync(path.join(repo, 'contracts/ipc'), path.join(root, 'contracts/ipc'), { recursive: true });
    mkdirSync(path.join(root, 'scripts/electron-migration/gate-checks'), { recursive: true });
    cpSync(path.join(repo, 'scripts/electron-migration/gate-checks/frontend-invoke-baseline.json'), path.join(root, 'scripts/electron-migration/gate-checks/frontend-invoke-baseline.json'));
    mkdirSync(path.join(root, 'src/x'), { recursive: true });
    writeFileSync(path.join(root, 'src/x/new.ts'), `${TAURI}export const f = () => invoke('notes_list_deleted', { page_size: 5 });\nexport const g = (c: string) => invoke(c);\n`);
    const mutated = run({ root });
    expect(mutated.findings.filter((x) => x.severity === 'error').map((x) => x.rule).sort()).toEqual(['dynamic-command', 'unknown-arg']);
  });

  it('--check lists open-argument call sites for review and still passes on them alone', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'w09-frontend-invoke-'));
    roots.push(root);
    cpSync(path.join(repo, 'contracts/ipc'), path.join(root, 'contracts/ipc'), { recursive: true });
    mkdirSync(path.join(root, 'src/x'), { recursive: true });
    writeFileSync(path.join(root, 'src/x/open.ts'), `${TAURI}export const f = (args: object) => invoke('notes_list_deleted', args);\n`);
    const out = execFileSync(process.execPath, [path.resolve(import.meta.dirname, 'frontend-invoke.mjs'), '--root', root, '--check'], { encoding: 'utf8' });
    expect(out).toContain('1 open-argument call site(s) to review');
    expect(out).toContain('src/x/open.ts:2 [open-args, review] notes_list_deleted');
    expect(run({ root }).summary).toMatchObject({ fresh: 0, review: 1 });
  });
});
