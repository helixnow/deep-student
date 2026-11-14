/**
 * RF-W01-panic-replies-internal-error（host/e2e/differential/rust-fixes/RF-W01-panic-replies-internal-error.json）：
 * Tauri 中命令 panic 时前端 Promise 永不 settle；Host 改为回复按契约 `error` 形状构造的统一内部错误。
 * 走生产连接层 `serveHost`，断言前端一定收到 InvokeResponse。
 */
import { describe, expect, it } from 'vitest';
import { definePlugin, type WindowRef } from '../api.ts';
import { serveHost, type HostTransport } from '../connection.ts';
import type { LaneContract } from '../contract.ts';
import { ContractSet } from '../contracts.ts';
import { HOST_PROTOCOL_VERSION, type HostToMain, type MainToHostMessage } from '../protocol.ts';

const SOURCE: WindowRef = { window: 'main', webview: 'main' };

class TestTransport implements HostTransport {
  readonly sent: HostToMain[] = [];
  private readonly listeners: ((message: unknown) => void)[] = [];
  send(message: HostToMain): void { this.sent.push(message); }
  onMessage(listener: (message: unknown) => void): void { this.listeners.push(listener); }
  onClose(_listener: () => void): void {}
  close(): void {}
  deliver(message: MainToHostMessage): void { for (const listener of this.listeners) listener(message); }
}

const LANE: LaneContract = {
  lane: 'RF-W01',
  generator: 'hand-written RF-W01 fixture',
  commands: [{
    name: 'rf_w01_panics',
    lane: 'RF-W01',
    rust: { file: 'src/rf_w01.rs', line: 1, fn: 'rf_w01_panics' },
    async: true,
    args: [],
    injected: [],
    result: { type: 'null' },
    error: { $ref: '_shared.json#/$defs/AppError' },
    frontend: 'app',
  }],
  events: [],
  $defs: {},
};

describe('RF-W01-panic-replies-internal-error', () => {
  it('RF-W01-panic-replies-internal-error: an unclassified throw (Rust: panic, the invoke never settles) replies the contract-shaped internal error', async () => {
    const plugin = definePlugin({
      meta: { id: 'fixture.rf-w01.panics', lane: 'RF-W01', commands: ['rf_w01_panics'] },
      apply(ctx) {
        ctx.commands.register('rf_w01_panics', () => { throw new Error('index out of bounds: the len is 0 but the index is 0'); });
      },
    });
    const transport = new TestTransport();
    const session = serveHost(transport, {
      installs: async () => [{ plugin }],
      contracts: () => ContractSet.fromDirectory().with([{ file: 'RF-W01.json', contract: LANE }]),
    });
    transport.deliver({ kind: 'handshake', protocol: HOST_PROTOCOL_VERSION, appDataDir: '/tmp/dstu-rf-w01', appVersion: '0.0.0-test', platform: 'linux', debug: false });
    expect(await session.ready).not.toBeNull();

    transport.deliver({ kind: 'invoke', id: 'panic-1', cmd: 'rf_w01_panics', args: {}, source: SOURCE });
    // Rust 原行为：tokio 任务 panic，resolver 被丢弃，前端这里永远等不到回复（src/ipc/mod.rs:371-389）。
    await expect.poll(() => transport.sent.find((m) => m.kind === 'result' && m.id === 'panic-1')).toEqual({
      kind: 'result', id: 'panic-1', ok: false,
      error: { error_type: 'Unknown', message: 'index out of bounds: the len is 0 but the index is 0', details: null },
    });

    // 一次 panic 不影响后续调用（Rust 中同一命令也能再次调用），回复仍然 settle。
    transport.deliver({ kind: 'invoke', id: 'panic-2', cmd: 'rf_w01_panics', args: {}, source: SOURCE });
    await expect.poll(() => transport.sent.some((m) => m.kind === 'result' && m.id === 'panic-2')).toBe(true);
    await session.shutdown();
  });
});
