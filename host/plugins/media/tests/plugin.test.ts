import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import media from '../index.ts';
import { unusedStorage } from './helpers/storage-double.ts';

function settings(values = new Map<string, string>()) {
  return { get: (key: string) => values.get(key) ?? null, save: (key: string, value: string) => { values.set(key, value); } };
}

it('loads media and uses the real wire contracts for settings', async () => {
  const values = new Map<string, string>();
  const host = await createTestHost({ plugins: [media], provide: { storage: unusedStorage(), settings: settings(values), paths: { appDataDir: process.cwd() } } });
  try {
    expect(host.ctx.media.formatTimestamp(65000)).toBe('01:05');
    expect(await host.invoke('get_ocr_engine_type')).toBe('paddle_ocr_vl');
    values.set('ocr.engine_type', 'arbitrary-legacy-value');
    expect(await host.invoke('get_ocr_engine_type')).toBe('arbitrary-legacy-value');
    expect(await host.invoke('set_ocr_thinking_enabled', { enabled: false })).toBe(true);
    expect(values.get('ocr.enable_thinking')).toBe('false');
    expect(await host.invoke('save_available_ocr_models', { models: [
      { configId: 'a', model: 'm1', engineType: 'e', name: 'A' },
      { configId: 'b', model: 'm2', engineType: 'e', name: 'B', enabled: false, priority: 9, isFree: true },
      { configId: 'c', model: 'm3', engineType: 'e', name: 'C', enabled: null, priority: null },
    ] })).toBe(true);
    expect(JSON.parse(values.get('ocr.available_models')!)).toEqual([
      { configId: 'a', model: 'm1', engineType: 'e', name: 'A', isFree: false, enabled: true, priority: 0 },
      { configId: 'b', model: 'm2', engineType: 'e', name: 'B', isFree: true, enabled: false, priority: 9 },
      { configId: 'c', model: 'm3', engineType: 'e', name: 'C', isFree: false, enabled: true, priority: 2 },
    ]);
    expect(await host.invoke('tts_stop')).toBeNull();
    if (process.platform === 'darwin' || process.platform === 'win32') {
      expect(await host.invoke('tts_check_available')).toBe(true);
    }
    expect(host.events).toEqual([]);
  } finally { await host.dispose(); }
});

it('maps settings failures to the Rust AppError shape and messages', async () => {
  const host = await createTestHost({ plugins: [media], provide: { storage: unusedStorage(), settings: {
    get() { throw new Error('db failure'); }, save() { throw new Error('db failure'); },
  }, paths: { appDataDir: process.cwd() } } });
  try {
    await expect(host.invoke('get_ocr_engine_type')).rejects.toEqual({
      error_type: 'Database', message: '读取 OCR 引擎配置失败: db failure', details: null,
    });
    await expect(host.invoke('set_ocr_thinking_enabled', { enabled: true })).rejects.toEqual({
      error_type: 'Database', message: '保存 OCR 推理配置失败: db failure', details: null,
    });
    await expect(host.invoke('save_available_ocr_models', { models: [] })).rejects.toEqual({
      error_type: 'Database', message: '保存 OCR 模型配置失败: db failure', details: null,
    });
  } finally { await host.dispose(); }
});
