import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost } from './host.ts';
import llm from '../index.ts';
import { LlmControl } from '../src/control.ts';
import { defaultFailoverPolicy } from '../src/policy.ts';

const hosts: Awaited<ReturnType<typeof createTestHost>>[] = [];
const secretsStub = {
  isEncryptedFormat: () => false,
  openCrypto: async () => { throw new Error('crypto unused in these tests'); },
};
afterEach(async () => { for (const host of hosts.splice(0)) await host.dispose(); });

describe('LLMManager cancellation and policy commands', () => {
  it('cancel_stream always acknowledges, including an unknown event', async () => {
    const host = await createTestHost({ plugins: [llm], provide: { settings: { get: () => null }, secrets: secretsStub } });
    hosts.push(host);
    expect(await host.invoke('cancel_stream', { streamEventName: 'unknown' })).toBe(true);
    expect(host.events).toEqual([]);
  });
  it('cancel_stream records notification and fallback logs in the original order', async () => {
    const logs: string[] = [];
    const logger = { info: (message: string) => logs.push(message), debug: (message: string) => logs.push(message),
      warn: (message: string) => logs.push(message), error: (message: string) => logs.push(message) };
    const host = await createTestHost({ plugins: [llm], provide: { settings: {}, secrets: secretsStub,
      log: { logger: () => logger },
    } });
    hosts.push(host);
    const signal = await host.ctx.llm.subscribeCancelStream('cancel-log');
    logs.length = 0;
    await host.invoke('cancel_stream', { streamEventName: 'cancel-log' });
    expect(signal.aborted).toBe(true);
    expect(logs).toEqual([
      '[Backend] cancel_stream 收到前端请求: cancel-log',
      '[Backend] 调用 llm_manager.request_cancel_stream...',
      '[LLM Manager] request_cancel_stream 开始处理: cancel-log',
      '[LLM Manager] 检查 cancel_channels...',
      '[LLM Manager] 找到 cancel_channel，发送取消信号...',
      '[LLM Manager] 取消信号已成功发送到 channel: cancel-log',
      '[LLM Manager] 写入 cancel_registry 作为备用...',
      '[LLM Manager] 已将取消标记写入 registry: cancel-log',
      '[LLM Manager] request_cancel_stream 完成',
      '[Backend] cancel_stream 命令处理完成，返回成功',
    ]);
    expect(await host.ctx.llm.consumePendingCancel('cancel-log')).toBe(true);
    expect(logs.at(-1)).toBe('[Cancel] Acknowledged and cleared cancel flag for stream: cancel-log');
  });
  it('register_cancel_channel replaces the sender; pending cancel is consumed once', async () => {
    const control = new LlmControl({ get: () => null, save: () => {} });
    await control.requestCancelStream('translation_stream_a');
    const old = await control.subscribeCancelStream('translation_stream_a');
    expect(old.aborted).toBe(false);
    expect(await control.consumePendingCancel('translation_stream_a')).toBe(true);
    expect(await control.consumePendingCancel('translation_stream_a')).toBe(false);
    const current = await control.subscribeCancelStream('translation_stream_a');
    await control.requestCancelStream('translation_stream_a');
    expect(current.aborted).toBe(true);
    expect(old.aborted).toBe(false);
    await control.clearCancelStream('translation_stream_a');
    expect(await control.consumePendingCancel('translation_stream_a')).toBe(true);
  });
  it('clear_cancel_artifacts clears both stores; prefix cancellation only matches registered channels', async () => {
    const control = new LlmControl({ get: () => null, save: () => {} });
    const a = await control.subscribeCancelStream('a:1');
    const b = await control.subscribeCancelStream('b:1');
    await control.cancelStreamsByPrefix('a:');
    expect(a.aborted).toBe(true);
    expect(b.aborted).toBe(false);
    await control.clearCancelArtifacts('a:1');
    expect(await control.consumePendingCancel('a:1')).toBe(false);
    await control.requestCancelStream('b:1');
    expect(b.aborted).toBe(true);
  });
  it('llm_get_failover_policy falls back for absent, empty or invalid stored policy', async () => {
    let raw: string | null = null;
    const host = await createTestHost({ plugins: [llm], provide: { settings: { get: () => raw }, secrets: secretsStub } });
    hosts.push(host);
    for (raw of [null, '', '  ', '{', 'null', '[]', '{"enabled":null}', '{"keyCooldownSecs":-1}']) {
      expect(await host.invoke('llm_get_failover_policy')).toEqual(defaultFailoverPolicy());
    }
  });
  it('llm_set_failover_policy applies serde defaults and persists the original setting key', async () => {
    const values = new Map<string, string>();
    const host = await createTestHost({ plugins: [llm], provide: { settings: {
      get: (key: string) => values.get(key) ?? null,
      save: (key: string, value: string) => { values.set(key, value); },
    }, secrets: secretsStub } });
    hosts.push(host);
    expect(await host.invoke('llm_set_failover_policy', { policy: { autoDegradeChat: true } })).toBe(null);
    const expected = { ...defaultFailoverPolicy(), autoDegradeChat: true };
    expect(JSON.parse(values.get('llm_failover_policy')!)).toEqual(expected);
    expect(await host.invoke('llm_get_failover_policy')).toEqual(expected);
    expect(host.events).toEqual([]);
  });
  it('policy storage errors retain AppError shape and Rust messages', async () => {
    const host = await createTestHost({ plugins: [llm], provide: { settings: {
      get: () => { throw new Error('disk error'); }, save: () => { throw new Error('disk error'); },
    }, secrets: secretsStub } });
    hosts.push(host);
    await expect(host.invoke('llm_get_failover_policy')).rejects.toEqual({ error_type: 'Database', message: '读取 Failover 策略失败: disk error', details: null });
    await expect(host.invoke('llm_set_failover_policy', { policy: {} })).rejects.toEqual({ error_type: 'Database', message: '保存 Failover 策略失败: disk error', details: null });
  });
  it('logs corrupted policy fallback and failed API configuration saves (L02-06)', async () => {
    const warnings: string[] = [], errors: string[] = [];
    const host = await createTestHost({ plugins: [llm], provide: {
      settings: { get: (key: string) => { if (key === 'llm_failover_policy') return '{'; throw new Error('disk unavailable'); } },
      secrets: secretsStub,
      log: { logger: () => ({ info: () => {}, debug: () => {}, warn: (text: string) => warnings.push(text), error: (text: string) => errors.push(text) }) },
    } });
    hosts.push(host);
    expect(await host.invoke('llm_get_failover_policy')).toEqual(defaultFailoverPolicy());
    expect(warnings).toContainEqual(expect.stringContaining('[Failover] 策略配置解析失败，回落默认值:'));
    await expect(host.invoke('save_api_configurations', { configs: [] })).rejects.toMatchObject({ error_type: 'Database' });
    expect(errors).toContainEqual(expect.stringMatching(/^\[后端\] API配置保存失败: .*disk unavailable/));
  });
});
