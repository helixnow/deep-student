import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createTestHost } from './host.ts';
import plugin from '../index.ts';
import { flushPendingDebugLogWrites } from '../src/audit_log.ts';
import { makeConfig } from './support.ts';

describe('published question authoring owner', () => {
  it('returns exact completion metadata and aborts an active provider socket through the public service', async () => {
    let started!: () => void, closed!: () => void;
    const streaming = new Promise<void>(resolve => { started = resolve; });
    const dropped = new Promise<void>(resolve => { closed = resolve; });
    let count = 0;
    const server = createServer((_request, response) => {
      count++;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (count === 1) response.end('data: {"choices":[{"delta":{"content":"{\\"questions\\":[]}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":4}}\n\ndata: [DONE]\n\n');
      else { response.on('close', closed); response.write('data: {"choices":[{"delta":{"content":"{\\"questions\\":"}}]}\n\n'); started(); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const host = await createTestHost({ plugins: [plugin], provide: { settings: { get: () => null }, secrets: { isEncryptedFormat: () => false } } });
    try {
      const config = makeConfig({ id: 'authoring-live', model: 'test-model', apiProtocol: 'openai_chat_completions',
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` });
      expect(await host.ctx.llmQuestionAuthoring.runQuestionJson(config, 'JSON', 'full source')).toEqual({
        content: '{"questions":[]}', finishReason: 'stop', usage: { prompt_tokens: 7, completion_tokens: 4 }, jsonMode: true,
      });
      const cancel = new AbortController();
      const pending = host.ctx.llmQuestionAuthoring.runQuestionJson(config, 'JSON', 'full source', cancel.signal);
      const rejected = expect(pending).rejects.toMatchObject({ value: { error_type: 'LLM', message: '题目文档解析(test-model) 请求已取消', details: null } });
      await streaming; cancel.abort(); await rejected; await dropped;
      expect(count).toBe(2);
    } finally { await host.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('publishes the strict persisted-log toggle and original fallback directory', async () => {
    let value: string | null = null;
    let fail = false;
    const host = await createTestHost({ plugins: [plugin], provide: { settings: { get: () => { if (fail) throw new Error('read failed'); return value; } }, secrets: {} } });
    try {
      expect(host.ctx.llmQuestionAuthoring.buildDebugPersistConfig()).toBeNull();
      value = 'TRUE'; expect(host.ctx.llmQuestionAuthoring.buildDebugPersistConfig()).toBeNull();
      value = 'true';
      const config = host.ctx.llmQuestionAuthoring.buildDebugPersistConfig();
      expect(config).toEqual({ log_dir: join(host.ctx.app.dataDir, 'logs', 'debug-logs') });
      // 目录经 `ctx.files` 异步创建：等后台动作落定后再核对（Rust 的 create_dir_all 是同步的）。
      expect(await flushPendingDebugLogWrites()).toBe(true);
      expect((await stat(config!.log_dir)).isDirectory()).toBe(true);
      fail = true; expect(host.ctx.llmQuestionAuthoring.buildDebugPersistConfig()).toBeNull();
    } finally { await host.dispose(); }
  });
});
