/**
 * 「保存并关闭」的保存挂点注册表（contentDirtyRegistry 扩展）
 *
 * 关窗确认对话框仅在视图注册了保存处理函数时提供「保存并关闭」；
 * saveContentNow 全部成功才放行关闭，任一失败/无注册保持窗口打开。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetContentDirtyRegistry,
  hasContentSaveHandler,
  registerContentSaveHandler,
  saveContentNow,
} from '@/features/workbench/apps/content/contentDirtyRegistry';

afterEach(() => {
  __resetContentDirtyRegistry();
});

describe('保存挂点注册与注销', () => {
  it('注册后 hasContentSaveHandler 为 true，注销后为 false', () => {
    expect(hasContentSaveHandler('translation', 'tr_1')).toBe(false);
    const unregister = registerContentSaveHandler('translation', 'tr_1', async () => undefined);
    expect(hasContentSaveHandler('translation', 'tr_1')).toBe(true);
    unregister();
    expect(hasContentSaveHandler('translation', 'tr_1')).toBe(false);
  });

  it('实例键统一规范化为叶 ID（路径别名不拆分挂点）', () => {
    registerContentSaveHandler('translation', '/tr_1', async () => undefined);
    expect(hasContentSaveHandler('translation', 'tr_1')).toBe(true);
  });
});

describe('saveContentNow', () => {
  it('保存成功返回 true 并调用处理函数', async () => {
    const save = vi.fn(async () => undefined);
    registerContentSaveHandler('translation', 'tr_1', save);
    await expect(saveContentNow('translation', 'tr_1')).resolves.toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('保存失败返回 false（关窗流程据此保持窗口打开）', async () => {
    registerContentSaveHandler('translation', 'tr_1', async () => {
      throw new Error('vfs write failed');
    });
    await expect(saveContentNow('translation', 'tr_1')).resolves.toBe(false);
  });

  it('无注册返回 false（不提供假保存成功）', async () => {
    await expect(saveContentNow('translation', 'tr_missing')).resolves.toBe(false);
  });

  it('同一资源多个保存面全部成功才算成功', async () => {
    const okSave = vi.fn(async () => undefined);
    registerContentSaveHandler('translation', 'tr_1', okSave);
    registerContentSaveHandler('translation', 'tr_1', async () => {
      throw new Error('second facet failed');
    });
    await expect(saveContentNow('translation', 'tr_1')).resolves.toBe(false);
  });
});
