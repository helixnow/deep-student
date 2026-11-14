import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyBaseline, judge, matches, run, scanEmitters, scanListeners, type Baseline, type Finding, type SourceEntry } from './event-emit.mjs';

const EVENT = "import { listen, once, emit } from '@tauri-apps/api/event';\n";
const rules = (findings: Finding[]) => findings.map((f) => [f.rule, f.event ?? f.function]);
const gaps = (listeners: SourceEntry[], emitters: SourceEntry[]) => judge(scanListeners(listeners), scanEmitters(emitters));

describe('event-emit gate: name resolution and matching', () => {
  it('collects literal, const, imported-const and enum event names on both sides', () => {
    const consts = { file: 'src/events.ts', text: "export const DONE = 'job-done';\nexport const EVENTS = { PROGRESS: 'job-progress' } as const;\nexport enum Ev { Fail = 'job-failed' }" };
    const ui = { file: 'src/ui.ts', text: `${EVENT}import { DONE, EVENTS, Ev } from './events';\nlisten(DONE, f); once(EVENTS.PROGRESS, f); listen(Ev.Fail, f); listen('never-sent', f);` };
    const host = { file: 'host/plugins/jobs/index.ts', text: "const DONE = 'job-done';\nctx.backendEvents.emit(DONE, {});\nevents.emitTo({ kind: 'Any' }, 'job-progress', 1);\nemit('job-failed', null);" };
    expect(rules(gaps([consts, ui], [host]))).toEqual([['unemitted-event', 'never-sent']]);
  });

  it('matches template patterns in either direction and ignores fully dynamic emitters', () => {
    const ui = { file: 'src/chat.ts', text: `${EVENT}listen(\`chat_v2_event_\${sessionId}\`, f);\nlisten(\`\${prefix}_done\`, f);\nlisten(\`orphan_\${id}\`, f);` };
    const host = { file: 'host/plugins/chat/index.ts', text: 'events.emit(`chat_v2_event_${s.id}`, p);\nevents.emit(stream + \'_done\', p);\nevents.emit(anything, p);' };
    expect(rules(gaps([ui], [host]))).toEqual([['unemitted-event', 'orphan_${…}']]);
    const emitters = scanEmitters([host]);
    expect(emitters.dynamic).toBe(1);
    expect(matches(['a_', null], [[null, '_x']])).toBe(false);
    expect(matches(['a_', null, '_x'], [['a_b_x']])).toBe(true);
  });

  it('follows listen aliases, window listeners and forwarding wrappers across files; dynamic names are dynamic-event', () => {
    const lib = { file: 'src/hooks/useEvt.ts', text: `${EVENT}import { listen as tauriListen } from '@tauri-apps/api/event';\nexport function useEvt(name, cb) { return tauriListen(name, cb); }` };
    const user = { file: 'src/user.tsx', text: "import { useEvt } from '@/hooks/useEvt';\nuseEvt('wrapped-missing', f);\nconst w = getCurrentWindow();\nw.listen('tauri://focus', f);\nnew WebviewWindow('x').once('tauri://created', f);\nlisten2(dyn);" };
    const findings = gaps([lib, user], [{ file: 'electron/shell/windows.ts', text: "emit('tauri://focus', null);" }]);
    expect(rules(findings)).toEqual([
      ['dynamic-event', 'useEvt'],
      ['unemitted-event', 'wrapped-missing'],
      ['unemitted-event', 'tauri://created'],
    ]);
  });

  it('emitter-ish callees count every resolvable argument, including names built by helpers and methods', () => {
    const ui = { file: 'src/ws.ts', text: `${EVENT}listen('workspace_closed', f); listen(\`chat_v2_event_\${id}\`, f); listen(\`translation_stream_\${s}\`, f); listen('ws_never', f);` };
    const host = { file: 'host/plugins/ws/emitter.ts', text: `const workspaceEvents = { CLOSED: 'workspace_closed' } as const;
export function streamChannel(sessionId) { return \`translation_stream_\${sessionId}\`; }
class Emitter {
  private send(event, payload) { this.sink(event, payload); }
  private blockEventChannel() { return \`chat_v2_event_\${this.sessionId}\`; }
  close() { this.send(workspaceEvents.CLOSED, {}); dispatchBlockEvent(this.sink, this.blockEventChannel(), 1); }
}` };
    const commands = { file: 'host/plugins/ws/commands.ts', text: "import { streamChannel } from './emitter.ts';\nctx.backendEvents.emit(streamChannel(id), chunk);" };
    expect(rules(gaps([ui], [host, commands]))).toEqual([['unemitted-event', 'ws_never']]);
  });

  it('resolves fields assigned in the constructor and drops emitter patterns with no static word', () => {
    const ui = { file: 'src/t.ts', text: `${EVENT}listen(\`translation_stream_\${s}\`, f); listen('canvas:note-updated', f);` };
    const host = { file: 'host/plugins/t/engine.ts', text: `function translationStreamEvent(id) { return \`translation_stream_\${id}\`; }
class Engine {
  private readonly streamEvent: string;
  constructor(id) { this.streamEvent = translationStreamEvent(id); }
  chunk() { this.events.emit(this.streamEvent, {}); this.events.emit(\`\${a}:\${b}\`, {}); }
}` };
    expect(rules(gaps([ui], [host]))).toEqual([['unemitted-event', 'canvas:note-updated']]);
  });

  it('wrappers may forward the event name at any parameter position', () => {
    const ui = { file: 'src/w.ts', text: `${EVENT}function sub(opts, name, cb) { return listen(name, cb); }\nsub({}, 'second-arg', f);` };
    expect(rules(gaps([ui], []))).toEqual([['dynamic-event', 'sub'], ['unemitted-event', 'second-arg']]);
  });

  it('frontend emit/emitTo count as emitters (cross-window events)', () => {
    const mini = { file: 'src/mini.ts', text: `${EVENT}listen('pomodoro:mini-command', f);` };
    const main = { file: 'src/main.ts', text: `${EVENT}import { emitTo } from '@tauri-apps/api/event';\nemitTo('pomodoro-mini', 'pomodoro:mini-command', {});` };
    expect(gaps([mini, main], [main])).toEqual([]);
  });

  it('registration entries whose name reaches listen through object fields or hook members count as listen sites (V03)', () => {
    const hub = { file: 'src/features/workbench/core/eventHub.ts', text: `${EVENT}const entries = new Map();
function ensureListening(entry) { entry.starting = listen(entry.eventName, f); }
export function hubListen(eventName, handler) { const entry = { eventName }; entries.set(eventName, entry); ensureListening(entry); }
export function hubListenKeyed(eventName, key, handler) { hubListen(eventName, handler); }` };
    const hook = { file: 'src/hooks/useTauriEventListener.ts', text: `${EVENT}export function useTauriEventListener() {
  const attach = useCallback(async function attach(eventName, handler) { return listen(eventName, handler); }, []);
  return { attach };
}` };
    const domain = { file: 'src/features/workbench/agent/domainEvents.ts', text: `import { hubListen } from '../core/eventHub';
function ensureHubSubscription(eventName) { hubListen(eventName, f); }
export function registerDomainListener(eventName, handler) { ensureHubSubscription(eventName); }` };
    const users = { file: 'src/features/x/users.ts', text: `import { hubListen, hubListenKeyed } from '@/features/workbench/core/eventHub';
import { registerDomainListener } from '@/features/workbench/agent/domainEvents';
import { useTauriEventListener } from '@/hooks/useTauriEventListener';
hubListen('browser_closed', f);
hubListenKeyed('chat_stream', id, f);
registerDomainListener('todo://changed', f);
registerDomainListener('nobody://changed', f);
export function useA() { const { attach } = useTauriEventListener(); attach('deepseek_ocr_log', f); }
export function useB() { const { attach: on } = useTauriEventListener(); on('stale_audit', f); }
export function useC() { const tauriEvents = useTauriEventListener(); tauriEvents.attach('exam_sheet_progress', f); }
export function attach(name) { return name; }
export function useD() { const other = { attach }; other.attach('not-an-event'); attach('not-an-event-either'); }` };
    const host = { file: 'host/plugins/x/index.ts', text: "events.emit('browser_closed', 1); events.emit('chat_stream', 1); events.emit('todo://changed', 1); events.emit('deepseek_ocr_log', 1); events.emit('exam_sheet_progress', 1);" };
    const listeners = scanListeners([hub, hook, domain, users]);
    expect(listeners.sites.filter((s) => s.file === 'src/features/x/users.ts').map((s) => [s.line, s.expression])).toEqual([
      [4, "'browser_closed'"], [5, "'chat_stream'"], [6, "'todo://changed'"], [7, "'nobody://changed'"],
      [8, "'deepseek_ocr_log'"], [9, "'stale_audit'"], [10, "'exam_sheet_progress'"],
    ]);
    expect(rules(judge(listeners, scanEmitters([host]))).filter(([rule]) => rule === 'unemitted-event')).toEqual([
      ['unemitted-event', 'nobody://changed'], ['unemitted-event', 'stale_audit'],
    ]);
  });

  it('listen reached through a dynamic import of the event module counts as a listen site (await, .then, module object, local loader)', () => {
    const ui = { file: 'src/dyn.ts', text: `async function a() { const { listen } = await import('@tauri-apps/api/event'); await listen('dyn-await', f); }
import('@tauri-apps/api/event').then(({ listen: on, once }) => { on('dyn-then', f); once('dyn-once', f); });
const events = () => import('@tauri-apps/api/event');
events().then(({ listen }) => listen('dyn-loader', f));
async function b() { const mod: any = await import('@tauri-apps/api/event'); return mod.listen('dyn-module', f); }
import('@tauri-apps/api/event').then((m) => m.listen('dyn-param', f));
async function c() { return (await import('@tauri-apps/api/event')).once('dyn-inline', f); }
export async function guarded(event, handler) { const mod = await import('@tauri-apps/api/event'); return mod.listen(event, handler); }
async function notEvents() { const { listen } = await import('./server'); listen('not-tauri', f); const mod = await import('./other'); mod.listen('nor-this'); }
import('./other').then(({ listen }) => listen('nor-that', f));` };
    const user = { file: 'src/user.ts', text: "import { guarded } from './dyn';\nguarded('dyn-wrapped', f);" };
    const listeners = scanListeners([ui, user]);
    expect(listeners.sites.map((s) => [s.file, s.line, s.expression])).toEqual([
      ['src/dyn.ts', 1, "'dyn-await'"], ['src/dyn.ts', 2, "'dyn-then'"], ['src/dyn.ts', 2, "'dyn-once'"], ['src/dyn.ts', 4, "'dyn-loader'"],
      ['src/dyn.ts', 5, "'dyn-module'"], ['src/dyn.ts', 6, "'dyn-param'"], ['src/dyn.ts', 7, "'dyn-inline'"], ['src/dyn.ts', 8, 'event'],
      ['src/user.ts', 2, "'dyn-wrapped'"],
    ]);
    expect(rules(judge(listeners, scanEmitters([{ file: 'host/plugins/x/index.ts', text: "events.emit('dyn-await', 1);" }])))).toEqual([
      ['unemitted-event', 'dyn-then'], ['unemitted-event', 'dyn-once'], ['unemitted-event', 'dyn-loader'], ['unemitted-event', 'dyn-module'],
      ['unemitted-event', 'dyn-param'], ['unemitted-event', 'dyn-inline'], ['dynamic-event', 'guarded'], ['unemitted-event', 'dyn-wrapped'],
    ]);
  });

  it('member .once/.listen on non-window receivers are not Tauri listeners', () => {
    expect(scanListeners([{ file: 'src/x.ts', text: "emitter.once('close', f); socket.listen('x');" }]).sites).toEqual([]);
  });
});

describe('event-emit gate: baseline', () => {
  const finding = (event: string): Finding => ({ rule: 'unemitted-event', file: 'src/a.ts', line: 1, function: 'f', event, message: '' });

  it('counts per rule+file+event; extra occurrences are new, missing ones stale', () => {
    const baseline: Baseline = { entries: [{ rule: 'unemitted-event', file: 'src/a.ts', event: 'x', count: 1 }, { rule: 'unemitted-event', file: 'src/a.ts', event: 'gone' }] };
    const { fresh, stale } = applyBaseline([finding('x'), finding('x'), finding('y')], baseline);
    expect(fresh.map((f) => f.event)).toEqual(['x', 'y']);
    expect(stale.map((e) => e.event)).toEqual(['gone']);
  });
});

describe('event-emit gate: run over a tree', () => {
  let root = '';
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  it('scans src/ listeners against host/, electron/ and src/ emitters and applies the baseline file', () => {
    root = mkdtempSync(path.join(tmpdir(), 'event-emit-'));
    const write = (file: string, text: string) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); };
    write('src/a.ts', `${EVENT}listen('covered', f); listen('known-gap', f); listen('new-gap', f);`);
    write('src/__tests__/a.test.ts', `${EVENT}listen('test-only', f);`);
    write('host/plugins/p/index.ts', "events.emit('covered', 1);");
    write('host/plugins/p/tests/x.test.ts', "events.emit('new-gap', 1);");
    write('scripts/electron-migration/gate-checks/event-emit-baseline.json', JSON.stringify({ entries: [{ rule: 'unemitted-event', file: 'src/a.ts', event: 'known-gap', count: 1 }] }));
    const result = run({ root });
    expect(result.summary).toMatchObject({ listeners: 3, existing: 2, baselined: 1, fresh: 1, stale: 0 });
    expect(result.findings.map((f) => [f.event, f.severity])).toEqual([['new-gap', 'error']]);
  });
});
