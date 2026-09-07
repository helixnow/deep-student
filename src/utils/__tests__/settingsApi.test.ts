import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('../shared', () => ({ isTauriRuntime: true }));

import { deleteSetting, getSetting, saveSettings } from '../settingsApi';

/**
 * N06（2026-09-07 审阅）：设置批量写入的回滚基线必须严格——读失败不能
 * 被当成"键不存在"；删除失败必须可见；回滚自身失败不中止其余补偿。
 */
describe('settingsApi N06 契约', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    localStorage.clear();
  });

  it('基线读取失败时在任何写入之前拒绝', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_setting') return Promise.reject(new Error('db busy'));
      return Promise.resolve(null);
    });

    await expect(saveSettings({ a: '1', b: '2' })).rejects.toThrow(/Failed to get setting/);
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === 'save_setting'),
    ).toHaveLength(0);
  });

  it('写入中途失败时按真实基线回滚已写键', async () => {
    const store = new Map<string, string>([['a', 'original-a']]);
    invokeMock.mockImplementation((cmd: string, args: { key: string; value?: string }) => {
      if (cmd === 'get_setting') return Promise.resolve(store.get(args.key) ?? null);
      if (cmd === 'save_setting') {
        if (args.key === 'b') return Promise.reject(new Error('write b failed'));
        store.set(args.key, args.value!);
        return Promise.resolve();
      }
      if (cmd === 'delete_setting') {
        store.delete(args.key);
        return Promise.resolve(true);
      }
      return Promise.resolve(null);
    });

    await expect(saveSettings({ a: 'new-a', b: 'new-b' })).rejects.toThrow(/save setting/);
    expect(store.get('a')).toBe('original-a');
    expect(store.has('b')).toBe(false);
  });

  it('基线不存在的键在回滚时删除而非写入垃圾值', async () => {
    const store = new Map<string, string>();
    invokeMock.mockImplementation((cmd: string, args: { key: string; value?: string }) => {
      if (cmd === 'get_setting') return Promise.resolve(store.get(args.key) ?? null);
      if (cmd === 'save_setting') {
        if (args.key === 'b') return Promise.reject(new Error('write b failed'));
        store.set(args.key, args.value!);
        return Promise.resolve();
      }
      if (cmd === 'delete_setting') {
        store.delete(args.key);
        return Promise.resolve(true);
      }
      return Promise.resolve(null);
    });

    await expect(saveSettings({ a: 'new-a', b: 'new-b' })).rejects.toThrow();
    expect(store.has('a')).toBe(false);
  });

  it('回滚中单个补偿失败不中止其余补偿', async () => {
    const store = new Map<string, string>([
      ['a', 'original-a'],
      ['b', 'original-b'],
    ]);
    invokeMock.mockImplementation((cmd: string, args: { key: string; value?: string }) => {
      if (cmd === 'get_setting') return Promise.resolve(store.get(args.key) ?? null);
      if (cmd === 'save_setting') {
        // 正向写入 a/b 成功、写 c 失败；回滚时恢复 b 失败、a 仍应被恢复
        if (args.key === 'c') return Promise.reject(new Error('write c failed'));
        if (args.key === 'b' && args.value === 'original-b') {
          return Promise.reject(new Error('rollback b failed'));
        }
        store.set(args.key, args.value!);
        return Promise.resolve();
      }
      return Promise.resolve(null);
    });

    await expect(saveSettings({ a: 'x', b: 'y', c: 'z' })).rejects.toThrow();
    expect(store.get('a')).toBe('original-a');
  });

  it('原生删除失败必须抛出，不得只清 localStorage 伪装成功', async () => {
    localStorage.setItem('k', 'v');
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'delete_setting') return Promise.reject(new Error('db locked'));
      return Promise.resolve(null);
    });

    await expect(deleteSetting('k')).rejects.toThrow(/Failed to delete setting/);
  });

  it('宽松读取保留展示路径的 localStorage 回退', async () => {
    localStorage.setItem('k', 'cached');
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_setting') return Promise.reject(new Error('ipc down'));
      return Promise.resolve(null);
    });

    await expect(getSetting('k')).resolves.toBe('cached');
  });
});
