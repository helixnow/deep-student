/**
 * 内置插件命令的兜底：与 W01 kernel 的“每个 invoke 都会 settle”一致——处理函数抛出意外值、
 * 或返回值无法编码时，前端 Promise 仍以统一的内部错误（Tauri 插件错误的形状：字符串）结束。
 */
import type { WebContents } from 'electron';
import { describe, expect, it } from 'vitest';
import type { MainToRenderer } from '../shell/bridge-messages.ts';
import { BuiltinAcl } from '../shell/capabilities.ts';
import { ShellCommandError } from '../shell/errors.ts';
import { PathResolver } from '../shell/paths.ts';
import { ShellRuntime, type BrowserWebview } from '../shell/runtime.ts';
import { FsScope } from '../shell/scope.ts';

function harness() {
  const logs: string[] = [];
  const runtime = new ShellRuntime({
    platform: 'linux',
    debug: false,
    config: {
      productName: 'F2 shell test', version: '0.0.0', identifier: 'test', devUrl: '', frontendDist: '', windows: [],
      assetScope: { allow: [], deny: [] }, assetProtocolEnabled: false, csp: null, macOSPrivateApi: false,
    },
    paths: new PathResolver({ platform: 'linux', env: {}, fallbackHome: '/tmp', identifier: 'test', tempDir: '/tmp', resourceDir: null }),
    assetScope: new FsScope({ platform: 'linux' }),
    fsScope: new FsScope({ platform: 'linux' }),
    appVersion: '0.0.0',
    localOrigin: 'tauri://localhost',
    log: (message) => logs.push(message),
    acl: new BuiltinAcl([{
      identifier: 'probe-content', description: '', local: false, remote: { urls: ['https://*'] }, windows: [], webviews: ['browser-content'],
      permissions: ['probe:default'], platforms: null,
    }], 'linux', {
      probe: { commands: ['bigint', 'object', 'cyclic', 'error', 'expected'], default: ['allow-bigint', 'allow-object', 'allow-cyclic', 'allow-error', 'allow-expected'], sets: {}, permissions: {} },
    }),
  });
  runtime.registerPlugin('probe', {
    bigint: () => ({ size: 1n }),
    object: () => { throw { code: 7, detail: 'not an Error' }; },
    cyclic: () => {
      const value: Record<string, unknown> = { code: 8 };
      value.self = value;
      throw value;
    },
    error: () => { throw new TypeError('boom'); },
    expected: () => { throw new ShellCommandError('expected failure'); },
  });
  const sent: MainToRenderer[] = [];
  const contents = { isDestroyed: () => false, send: (_channel: string, message: MainToRenderer) => sent.push(message) } as unknown as WebContents;
  const entry: BrowserWebview = { label: 'browser-content', windowLabel: 'main', webContents: contents, initializationScript: '' };
  const invoke = async (cmd: string) => {
    runtime.handleBrowserInvoke(contents, entry, {
      type: 'invoke', cmd, callback: 1, error: 2, payload: { contentType: 'application/json', data: '{}' }, headers: {},
    }, 'https://example.com/');
    for (let attempt = 0; attempt < 20 && sent.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    return sent.shift();
  };
  return { invoke, logs };
}

describe('builtin command fallback (every invoke settles)', () => {
  it('a return value that cannot be encoded becomes an error reply instead of a pending promise', async () => {
    const { invoke, logs } = harness();
    const reply = await invoke('plugin:probe|bigint');
    expect(reply).toMatchObject({ type: 'result', callbackId: 2, otherId: 1 });
    expect(reply && reply.type === 'result' ? JSON.parse((reply.body as { data: string }).data) : null).toMatch(/BigInt/);
    expect(logs.some((line) => line.includes('plugin:probe|bigint') && line.includes('BigInt'))).toBe(true);
  });

  it('a thrown non-Error is reported with its JSON form, not "[object Object]"', async () => {
    const { invoke } = harness();
    const reply = await invoke('plugin:probe|object');
    expect(reply).toMatchObject({ type: 'result', callbackId: 2 });
    const value = JSON.parse((reply as { body: { data: string } }).body.data) as string;
    expect(value).toBe('{"code":7,"detail":"not an Error"}');
  });

  it('a thrown value without a JSON form (cyclic) falls back to String() and still settles', async () => {
    const { invoke } = harness();
    const reply = await invoke('plugin:probe|cyclic');
    expect(reply).toMatchObject({ type: 'result', callbackId: 2 });
    expect(JSON.parse((reply as { body: { data: string } }).body.data)).toBe('[object Object]');
  });

  it('settles an expected shell error and logs it without exposing diagnostic metadata to remote content', async () => {
    const { invoke, logs } = harness();
    const reply = await invoke('plugin:probe|expected');
    expect(reply).toMatchObject({ type: 'result', callbackId: 2 });
    expect(JSON.parse((reply as { body: { data: string } }).body.data)).toBe('expected failure');
    expect(reply).not.toHaveProperty('diagnostic');
    const diagnostic = logs.find(line => line.startsWith('[diagnostic] '));
    expect(JSON.parse(diagnostic!.slice('[diagnostic] '.length))).toMatchObject({
      source: 'electron', operation: 'plugin:probe|expected', message: 'expected failure',
    });
  });

  it('a thrown Error keeps the existing message-only reply', async () => {
    const { invoke } = harness();
    const reply = await invoke('plugin:probe|error');
    expect(JSON.parse((reply as { body: { data: string } }).body.data)).toBe('boom');
  });
});
