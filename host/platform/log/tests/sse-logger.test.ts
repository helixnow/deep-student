/**
 * F4 SSE/UTF-8 单一实现的日志接线：生产 `dstu.platform.log` 插件在 apply 时绑定
 * `setSseBufferLogger`，L01/L02 消费方无需在测试或生产代码里各自注入。
 */
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createPaths } from '../../paths/index.ts';
import { setSseBufferLogger, SseLineBuffer } from '../../util/sse-buffer.ts';
import log from '../index.ts';

it('log plugin binds the shared SSE buffer logger to the production log target', async () => {
  const host = await createTestHost();
  try {
    host.ctx.reflect.provide('paths', createPaths({
      dataDir: host.app.dataDir,
      platform: host.app.platform,
      env: {
        HOME: host.app.dataDir,
        USERPROFILE: host.app.dataDir,
        APPDATA: host.app.dataDir,
        LOCALAPPDATA: host.app.dataDir,
      },
    }));
    await host.install(log);

    const buffer = new SseLineBuffer(8);
    expect(buffer.processChunk('123456789')).toEqual([]);

    const text = readFileSync(host.ctx.log.mainLogFile, 'utf8');
    expect(text).toContain('[ERROR][dstu_util::utils::sse_buffer]');
    expect(text).toContain('SSE缓冲区超过大小上限');
  } finally {
    await host.dispose();
  }

  // 插件卸载后 setter 已清理，再触发只应静默，不应写已关闭的日志文件。
  const afterDispose = new SseLineBuffer(8);
  expect(() => afterDispose.processChunk('123456789')).not.toThrow();
});

it('unbinding one host logger does not clear another host binding', () => {
  const callsA: string[] = [];
  const callsB: string[] = [];
  const unbindA = setSseBufferLogger((_level, message) => callsA.push(message));
  const unbindB = setSseBufferLogger((_level, message) => callsB.push(message));

  // A 先卸载，B 仍应是当前 logger。
  unbindA();
  new SseLineBuffer(8).processChunk('123456789');
  expect(callsA).toHaveLength(0);
  expect(callsB).toHaveLength(1);

  unbindB();
  new SseLineBuffer(8).processChunk('123456789');
  expect(callsB).toHaveLength(1);
});
