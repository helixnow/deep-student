/**
 * W01：命令边界统一兜底（API.md §2.3）。处理函数抛出**任何**值，前端 Promise 都必须 settle：
 * - `CommandError` / 裸 `AppError` 普通对象 → 按 Rust `Err(E)` 原样 reject；
 * - 其他任何异常 → 带栈记 error 日志，reject 按命令契约 `error` 形状构造的统一内部错误。
 * 同时覆盖生产连接层（`serveHost`）与测试宿主（`HandlerPanic.reply`）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { definePlugin, HOST_CALL_COMMAND, type WindowRef } from '../api.ts';
import { serveHost, type HostTransport } from '../connection.ts';
import type { CommandContract, JsonSchema, LaneContract } from '../contract.ts';
import { ContractSet } from '../contracts.ts';
import { AppError, CommandError } from '../error-model.ts';
import { HOST_PROTOCOL_VERSION, type HostToMain, type InvokeResponse, type MainToHostMessage } from '../protocol.ts';
import { createTestHost, HandlerPanic, type TestHost } from '../testing.ts';
import { StorageError } from '../../platform/storage/api.ts';

const SOURCE: WindowRef = { window: 'main', webview: 'main' };
const FIXTURES = fileURLToPath(new URL('../__fixtures__/', import.meta.url));
const DATA_DIR = mkdtempSync(join(tmpdir(), 'dstu-w01-settle-'));
afterAll(() => rmSync(DATA_DIR, { recursive: true, force: true }));

function command(name: string, error: JsonSchema | undefined): CommandContract {
  return {
    name,
    lane: 'W01-settle',
    rust: { file: 'src/w01_settle.rs', line: 1, fn: name },
    async: true,
    args: [{ key: 'kind', rustName: 'kind', schema: { type: 'string' }, optional: false }],
    injected: [],
    result: { type: 'null' },
    ...(error === undefined ? {} : { error }),
    frontend: 'app',
  };
}

/** 覆盖仓库里出现过的全部 `error` 形状：String / AppError / CommandError 信封 / DstuError / 非 Result。 */
const LANE: LaneContract = {
  lane: 'W01-settle',
  generator: 'hand-written W01 fixture (shapes copied from contracts/ipc)',
  commands: [
    command('w01_settle_string', { type: 'string' }),
    command('w01_settle_app', { $ref: '_shared.json#/$defs/AppError' }),
    command('w01_settle_envelope', { $ref: '_shared.json#/$defs/CommandError' }),
    command('w01_settle_dstu', { $ref: 'L13-vfs-api.json#/$defs/DstuError' }),
    command('w01_settle_infallible', undefined),
  ],
  events: [],
  $defs: {},
};
const COMMANDS = LANE.commands.map((c) => c.name);
const contracts = () => ContractSet.fromDirectory().with([{ file: 'W01-settle.json', contract: LANE }]);

const hostile = new Proxy({}, {
  get() { throw new Error('hostile get'); },
  getPrototypeOf() { throw new Error('hostile getPrototypeOf'); },
  ownKeys() { throw new Error('hostile ownKeys'); },
  has() { throw new Error('hostile has'); },
});

/** 每种被抛出的值，以及统一错误里应出现的 message。 */
const THROWN: Record<string, { make: () => unknown; message: string | RegExp }> = {
  'error': { make: () => new Error('boom'), message: 'boom' },
  'type-error': { make: () => (undefined as unknown as { x: () => void }).x(), message: /Cannot read properties of undefined/ },
  'range-error': { make: () => new RangeError('index out of bounds'), message: 'index out of bounds' },
  'storage-error': {
    make: () => new StorageError('SQLITE', 'no such table: files', { sqliteCode: 'SQLITE_ERROR', database: 'vfs' }),
    message: 'no such table: files',
  },
  'string': { make: () => 'plain string failure', message: 'plain string failure' },
  'undefined': { make: () => undefined, message: 'undefined' },
  'null': { make: () => null, message: 'null' },
  'number': { make: () => 42, message: '42' },
  'bigint': { make: () => 12345678901234567890n, message: '12345678901234567890' },
  'symbol': { make: () => Symbol('sym'), message: 'Symbol(sym)' },
  'object': { make: () => ({ code: 7, reason: 'nope' }), message: '{"code":7,"reason":"nope"}' },
  'message-object': { make: () => ({ message: 'shaped like an error' }), message: 'shaped like an error' },
  'null-proto': { make: () => Object.assign(Object.create(null) as object, { a: 1 }), message: '{"a":1}' },
  'near-app-error': {
    // 多一个键：不是 Rust AppError 的序列化形状，不能原样外发。
    make: () => ({ ...AppError.validation('extra key'), extra: true }),
    message: 'extra key',
  },
  'hostile': { make: () => hostile, message: /./ },
};

function settlePlugin() {
  return definePlugin({
    meta: { id: 'fixture.w01-settle', commands: COMMANDS },
    apply(ctx) {
      for (const name of COMMANDS) {
        ctx.commands.register<{ kind: string }>(name, async ({ kind }) => {
          await Promise.resolve();
          if (kind === 'ok') return null;
          if (kind === 'app-error') throw AppError.not_found('资源不存在: r1');
          if (kind === 'app-error-details') throw AppError.with_details('Conflict', 'REVIEW_CONFLICT', { field: 'title' });
          if (kind === 'command-error') throw new CommandError('explicit');
          if (kind === 'async-reject') return Promise.reject(new TypeError('rejected later'));
          if (kind === 'sync-throw') throw new Error('sync');
          throw THROWN[kind]!.make();
        });
      }
    },
  });
}

/** 统一错误按契约 `error` 形状构造：AppError → Unknown，CommandError 信封 → INTERNAL_ERROR，DstuError → Internal，其余 → 字符串。 */
function expectedReply(cmd: string, message: string | RegExp): unknown {
  const text = typeof message === 'string' ? message : expect.stringMatching(message);
  switch (cmd) {
    case 'w01_settle_app': return { error_type: 'Unknown', message: text, details: null };
    case 'w01_settle_envelope': return { code: 'INTERNAL_ERROR', message: text };
    case 'w01_settle_dstu': return { type: 'Internal', message: text };
    default: return text;
  }
}

const hosts: TestHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
});

async function testHost(debug: boolean): Promise<TestHost> {
  const host = await createTestHost({ plugins: [settlePlugin()], contracts: contracts(), app: { debug } });
  hosts.push(host);
  return host;
}

describe.each([true, false])('test host settles every thrown value (debug=%s)', (debug) => {
  it.each(Object.keys(THROWN))('%s → HandlerPanic carrying the contract-shaped reply', async (kind) => {
    const host = await testHost(debug);
    for (const cmd of COMMANDS) {
      const error = await host.invoke(cmd, { kind }).then(() => 'resolved', (e: unknown) => e);
      expect(error, `${cmd}/${kind}`).toBeInstanceOf(HandlerPanic);
      expect((error as HandlerPanic).reply, `${cmd}/${kind}`).toEqual(expectedReply(cmd, THROWN[kind]!.message));
    }
  });

  it('async rejections and synchronous throws settle the same way', async () => {
    const host = await testHost(debug);
    for (const [kind, message] of [['async-reject', 'rejected later'], ['sync-throw', 'sync']] as const) {
      const error = await host.invoke('w01_settle_app', { kind }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HandlerPanic);
      expect((error as HandlerPanic).reply).toEqual({ error_type: 'Unknown', message, details: null });
    }
  });

  it('a bare AppError object is sent verbatim like CommandError(AppError)', async () => {
    const host = await testHost(debug);
    await expect(host.invoke('w01_settle_app', { kind: 'app-error' }))
      .rejects.toEqual({ error_type: 'NotFound', message: '资源不存在: r1', details: null });
    await expect(host.invoke('w01_settle_app', { kind: 'app-error-details' }))
      .rejects.toEqual({ error_type: 'Conflict', message: 'REVIEW_CONFLICT', details: { field: 'title' } });
    await expect(host.invoke('w01_settle_string', { kind: 'command-error' })).rejects.toBe('explicit');
  });
});

describe('bare AppError keeps CommandError contract checks', () => {
  it('debug: a bare AppError on a String-error command is a contract violation (still settles)', async () => {
    const host = await testHost(true);
    await expect(host.invoke('w01_settle_string', { kind: 'app-error' }))
      .rejects.toMatch(/^\[dstu-host\] command "w01_settle_string" rejected with a value that violates its contract/);
  });

  it('release: the bare AppError is sent as-is, matching Rust serde of the thrown value', async () => {
    const host = await testHost(false);
    await expect(host.invoke('w01_settle_string', { kind: 'app-error' }))
      .rejects.toEqual({ error_type: 'NotFound', message: '资源不存在: r1', details: null });
  });
});

describe('kernel failures after the handler returns still settle', () => {
  it('release: unserializable results and CommandError values produce the unified error', async () => {
    const cyclic: Record<string, unknown> = { n: 1n };
    cyclic.self = cyclic;
    const plugin = definePlugin({
      meta: { id: 'fixture.w01-wire', commands: ['w01_settle_string', 'w01_settle_app'] },
      apply(ctx) {
        ctx.commands.register('w01_settle_string', () => cyclic);
        ctx.commands.register('w01_settle_app', () => { throw new CommandError(cyclic); });
      },
    });
    const host = await createTestHost({ plugins: [plugin], contracts: contracts(), app: { debug: false } });
    hosts.push(host);
    const result = await host.invoke('w01_settle_string', { kind: 'x' }).catch((e: unknown) => e);
    expect(result).toBeInstanceOf(HandlerPanic);
    expect((result as HandlerPanic).reply).toEqual(expect.stringMatching(/circular/i));
    const rejected = await host.invoke('w01_settle_app', { kind: 'x' }).catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(HandlerPanic);
    expect((rejected as HandlerPanic).reply).toEqual({ error_type: 'Unknown', message: expect.stringMatching(/circular/i), details: null });
  });
});

describe('plugin:host|call', () => {
  it('a crashing remote method settles with an AppError Unknown reply', async () => {
    class Crashy { crash() { throw new TypeError('remote crash'); } }
    const plugin = definePlugin({
      meta: { id: 'fixture.w01-remote', provides: ['w01Crashy'], remote: { w01Crashy: ['crash'] } },
      apply(ctx) { ctx.provide('w01Crashy', new Crashy()); },
    });
    const host = await createTestHost({ plugins: [plugin], contracts: contracts() });
    hosts.push(host);
    const outcome = await host.runtime.dispatchInvoke({
      id: 'w01-remote', cmd: HOST_CALL_COMMAND, args: { caller: 'fixture.w01-remote', service: 'w01Crashy', method: 'crash', args: [] }, source: SOURCE,
    });
    expect(outcome).toMatchObject({ kind: 'panic', reply: { error_type: 'Unknown', message: 'remote crash', details: null } });
  });
});

// ------------------------------------------------------------------ 生产连接层

class CloningTransport implements HostTransport {
  readonly sent: HostToMain[] = [];
  private readonly listeners: ((message: unknown) => void)[] = [];
  private readonly waiters = new Map<string, (response: InvokeResponse) => void>();
  /** MessagePort / utilityProcess 的 structured clone 语义：不可克隆的值让 send 抛 DataCloneError。 */
  send(message: HostToMain): void {
    const copy = structuredClone(message);
    this.sent.push(copy);
    if (copy.kind === 'result') this.waiters.get(copy.id)?.(copy);
  }
  onMessage(listener: (message: unknown) => void): void { this.listeners.push(listener); }
  onClose(): void {}
  close(): void {}
  deliver(message: MainToHostMessage): void { for (const listener of this.listeners) listener(message); }
  /** 投递 invoke 并等待它的 InvokeResponse；2 秒内没有回复即失败（= 前端 Promise 挂起）。 */
  invoke(id: string, cmd: string, args: unknown): Promise<InvokeResponse> {
    return new Promise<InvokeResponse>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`invoke ${id} (${cmd}) got no InvokeResponse`)), 2000);
      this.waiters.set(id, (response) => {
        clearTimeout(timer);
        this.waiters.delete(id);
        resolve(response);
      });
      this.deliver({ kind: 'invoke', id, cmd, args, source: SOURCE });
    });
  }
}

async function bootProduction(debug: boolean, extraPlugin = settlePlugin()) {
  const transport = new CloningTransport();
  const logs: string[] = [];
  const session = serveHost(transport, {
    profile: `${FIXTURES}startup.profile.json`,
    contracts,
    onRuntime: (runtime) => {
      runtime.ctx.logger.exporter({
        levels: { default: 3 },
        export(message) { logs.push(`${message.type} [${message.name}] ${format(...(message.args as unknown[]))}`); },
      });
    },
  });
  transport.deliver({ kind: 'handshake', protocol: HOST_PROTOCOL_VERSION, appDataDir: DATA_DIR, appVersion: '0.0.0-test', platform: 'linux', debug });
  const runtime = await session.ready;
  if (!runtime) throw new Error('Host did not become ready');
  await runtime.install(extraPlugin);
  let seq = 0;
  const invoke = (cmd: string, args: unknown) => transport.invoke(`w01-prod-${++seq}`, cmd, args);
  return { transport, session, logs, invoke };
}

describe.each([true, false])('production serveHost always replies (debug=%s)', (debug) => {
  it('every thrown value produces an InvokeResponse with the contract-shaped error and a stack in the log', async () => {
    const { session, logs, invoke } = await bootProduction(debug);
    try {
      for (const kind of Object.keys(THROWN)) {
        for (const cmd of COMMANDS) {
          const response = await invoke(cmd, { kind });
          expect(response, `${cmd}/${kind}`).toMatchObject({ ok: false });
          expect((response as { error: unknown }).error, `${cmd}/${kind}`).toEqual(expectedReply(cmd, THROWN[kind]!.message));
        }
      }
      expect(await invoke('w01_settle_app', { kind: 'app-error' }))
        .toMatchObject({ ok: false, error: { error_type: 'NotFound', message: '资源不存在: r1', details: null } });
      expect(await invoke('w01_settle_string', { kind: 'ok' })).toMatchObject({ ok: true, value: null });
      const line = logs.find((l) => l.startsWith('error [commands]') && l.includes('"w01_settle_app"') && l.includes('RangeError: index out of bounds'));
      expect(line, logs.join('\n')).toBeDefined();
      expect(line).toMatch(/\n\s+at /);
    } finally {
      await session.shutdown();
    }
  });
});

describe('production send failures', () => {
  it('release: a reply that cannot be structured-cloned is replaced by a unified error instead of hanging', async () => {
    // V08-10 projects a plain `{ callback }` to JSON; the cycle defeats the projection, so the function reaches the transport.
    const unsendable: Record<string, unknown> = { callback: () => 1 };
    unsendable.self = unsendable;
    const plugin = definePlugin({
      meta: { id: 'fixture.w01-clone', commands: ['w01_settle_envelope'] },
      apply(ctx) {
        ctx.commands.register('w01_settle_envelope', () => unsendable);
      },
    });
    const transport = new CloningTransport();
    const logs: string[] = [];
    const session = serveHost(transport, {
      profile: `${FIXTURES}startup.profile.json`,
      contracts,
      onRuntime: (runtime) => {
        runtime.ctx.logger.exporter({ levels: { default: 3 }, export(message) { logs.push(format(...(message.args as unknown[]))); } });
      },
    });
    transport.deliver({ kind: 'handshake', protocol: HOST_PROTOCOL_VERSION, appDataDir: DATA_DIR, appVersion: '0.0.0-test', platform: 'linux', debug: false });
    const runtime = await session.ready;
    try {
      await runtime!.install(plugin);
      expect(await transport.invoke('clone-1', 'w01_settle_envelope', { kind: 'x' })).toMatchObject({
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: expect.stringContaining('w01_settle_envelope') },
      });
      expect(logs.some((l) => l.includes('clone-1') && /could not be cloned|DataCloneError/.test(l)), logs.join('\n')).toBe(true);
    } finally {
      await session.shutdown();
    }
  });
});
