import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
const showGlobalNotificationMock = vi.fn();
const isEnabledMock = vi.fn();
const launchMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: (...args: unknown[]) => showGlobalNotificationMock(...args),
}));

vi.mock('@/features/workbench/core/workbenchBus', () => ({
  workbenchBus: {
    isEnabled: () => isEnabledMock(),
    launch: (...args: unknown[]) => launchMock(...args),
  },
}));

vi.mock('i18next', () => ({
  default: {
    t: (key: string) => key,
  },
}));

import { openNodeRef } from '../openNodeRef';

describe('openNodeRef', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    showGlobalNotificationMock.mockReset();
    isEnabledMock.mockReset();
    launchMock.mockReset();
    isEnabledMock.mockReturnValue(true);
  });

  it('returns false immediately for empty or slash-only sourceId', async () => {
    expect(await openNodeRef('')).toBe(false);
    expect(await openNodeRef('/')).toBe(false);
    expect(await openNodeRef('   ///  ')).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(showGlobalNotificationMock).not.toHaveBeenCalled();
  });

  it('verifies note_* via dstu_get and launches workbench window when enabled', async () => {
    invokeMock.mockResolvedValueOnce({
      id: 'note_PzfvZKLlnX',
      type: 'note',
      name: '机器学习三大范式对比',
    });

    const ok = await openNodeRef('note_PzfvZKLlnX', {
      type: 'note',
      name: '机器学习三大范式对比',
    });

    expect(ok).toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('dstu_get', {
      path: '/note_PzfvZKLlnX',
    });
    expect(launchMock).toHaveBeenCalledWith({
      typeId: 'note',
      instanceKey: 'note_PzfvZKLlnX',
      payload: { title: '机器学习三大范式对比' },
      reason: 'api',
    });
    expect(showGlobalNotificationMock).not.toHaveBeenCalled();
  });

  it('dispatches NAVIGATE_TO_VIEW for note_* in WebUI / legacy mode', async () => {
    isEnabledMock.mockReturnValue(false);
    invokeMock.mockResolvedValueOnce({
      id: 'note_PzfvZKLlnX',
      type: 'note',
      name: '机器学习三大范式对比',
    });

    const events: Array<{ view?: string; openResource?: string }> = [];
    const listener = (e: Event) => {
      events.push((e as CustomEvent<{ view?: string; openResource?: string }>).detail);
    };
    window.addEventListener('NAVIGATE_TO_VIEW', listener);

    try {
      const ok = await openNodeRef('note_PzfvZKLlnX', {
        type: 'note',
        name: '机器学习三大范式对比',
      });

      expect(ok).toBe(true);
      expect(events).toEqual([
        { view: 'learning-hub', openResource: '/note_PzfvZKLlnX' },
      ]);
      expect(launchMock).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('NAVIGATE_TO_VIEW', listener);
    }
  });

  it('strips leading slashes before checking dstu_get and launching', async () => {
    invokeMock.mockResolvedValueOnce({
      id: 'mm_abc123',
      type: 'mindmap',
      name: '导图标题',
    });

    const ok = await openNodeRef('//mm_abc123');

    expect(ok).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('dstu_get', { path: '/mm_abc123' });
    expect(launchMock).toHaveBeenCalledWith({
      typeId: 'mindmap',
      instanceKey: 'mm_abc123',
      payload: { title: '导图标题' },
      reason: 'api',
    });
  });

  it.each([
    ['tb_1', 'textbook', '微积分教材'],
    ['exam_1', 'exam', '期中试卷'],
    ['tr_1', 'translation', '英文翻译'],
    ['essay_1', 'essay', '议论文批改'],
    ['file_1', 'file', '讲义.docx'],
    ['img_1', 'image', '示意图.png'],
  ])('opens %s (%s) via dstu_get', async (id, type, name) => {
    invokeMock.mockResolvedValueOnce({ id, type, name });

    const ok = await openNodeRef(id, { type, name });

    expect(ok).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('dstu_get', { path: `/${id}` });
    expect(launchMock).toHaveBeenCalledWith({
      typeId: type,
      instanceKey: id,
      payload: { title: name },
      reason: 'api',
    });
  });

  it('resolves res_* through vfs_get_resource and verifies linked DSTU entity', async () => {
    invokeMock
      .mockResolvedValueOnce({
        id: 'res_123',
        sourceId: 'note_linked',
        type: 'note',
      })
      .mockResolvedValueOnce({
        id: 'note_linked',
        type: 'note',
        name: '关联笔记',
      });

    const ok = await openNodeRef('res_123');

    expect(ok).toBe(true);
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'vfs_get_resource', {
      resourceId: 'res_123',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'dstu_get', {
      path: '/note_linked',
    });
    expect(launchMock).toHaveBeenCalledWith({
      typeId: 'note',
      instanceKey: 'note_linked',
      payload: { title: '关联笔记' },
      reason: 'api',
    });
  });

  it('supports standalone res_* without sourceId', async () => {
    invokeMock.mockResolvedValueOnce({
      id: 'res_only',
      sourceId: null,
      type: 'file',
      metadata: { title: '独立资源' },
    });

    const ok = await openNodeRef('res_only');

    expect(ok).toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('vfs_get_resource', {
      resourceId: 'res_only',
    });
    expect(launchMock).toHaveBeenCalledWith({
      typeId: 'file',
      instanceKey: 'res_only',
      payload: { title: '独立资源' },
      reason: 'api',
    });
  });

  it('warns and returns false when res_* points to a deleted DSTU entity', async () => {
    invokeMock
      .mockResolvedValueOnce({
        id: 'res_123',
        sourceId: 'note_deleted',
        type: 'note',
      })
      .mockResolvedValueOnce(null);

    const ok = await openNodeRef('res_123');

    expect(ok).toBe(false);
    expect(showGlobalNotificationMock).toHaveBeenCalledWith('warning', 'refs.unavailable');
    expect(launchMock).not.toHaveBeenCalled();
  });

  it('warns and returns false when dstu_get or vfs_get_resource returns null or throws', async () => {
    invokeMock.mockResolvedValueOnce(null);
    expect(await openNodeRef('note_missing')).toBe(false);
    expect(showGlobalNotificationMock).toHaveBeenCalledWith('warning', 'refs.unavailable');

    showGlobalNotificationMock.mockReset();
    invokeMock.mockRejectedValueOnce(new Error('Invalid DSTU path'));
    expect(await openNodeRef('zzz_invalid')).toBe(false);
    expect(showGlobalNotificationMock).toHaveBeenCalledWith('warning', 'refs.unavailable');

    showGlobalNotificationMock.mockReset();
    invokeMock.mockResolvedValueOnce(null);
    expect(await openNodeRef('res_missing')).toBe(false);
    expect(showGlobalNotificationMock).toHaveBeenCalledWith('warning', 'refs.unavailable');
    expect(launchMock).not.toHaveBeenCalled();
  });

  it('treats folder nodes as unavailable instead of launching an invalid editor', async () => {
    invokeMock.mockResolvedValueOnce({
      id: 'fld_1',
      type: 'folder',
      name: '文件夹',
    });

    const ok = await openNodeRef('fld_1', { type: 'folder', name: '文件夹' });

    expect(ok).toBe(false);
    expect(showGlobalNotificationMock).toHaveBeenCalledWith('warning', 'refs.unavailable');
    expect(launchMock).not.toHaveBeenCalled();
  });
});
