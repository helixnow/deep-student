/**
 * #447：同步进度/取消是应用级全局状态
 *
 * 设置页栏目是 lazy + 条件渲染，切栏目会卸载同步面板。进度若是组件局部
 * state，切回后按钮仍灰（全局 isSyncing）而进度区空白。这里验证：
 * - 应用级进度事件监听只注册一次、与组件无关，事件写入全局 store；
 * - 未在同步时的迟到事件被忽略；
 * - endSync 清空进度，或保留调用方给出的失败进度；
 * - 取消请求走全局 store，后端拒绝（无进行中同步）时复位。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncProgress } from '@/types/dataGovernance';

type ProgressHandler = (event: { payload: SyncProgress }) => void;

const eventMock = vi.hoisted(() => ({
  handlers: [] as Array<{ event: string; handler: unknown }>,
  listen: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: eventMock.listen,
}));

const cancelSyncMock = vi.hoisted(() => vi.fn());
vi.mock('@/api/dataGovernance', () => ({
  cancelSync: cancelSyncMock,
}));

import {
  __resetSyncProgressListenerForTests,
  createFailedSyncProgress,
  ensureSyncProgressListener,
  useGlobalSyncStore,
} from '../syncStatusStore';

const uploading: SyncProgress = {
  phase: 'uploading',
  percent: 40,
  current: 4,
  total: 10,
  current_item: 'chat_v2.db',
  speed_bytes_per_sec: 1024,
  eta_seconds: 12,
  error: null,
};

function emit(progress: SyncProgress) {
  for (const { event, handler } of eventMock.handlers) {
    if (event === 'data-governance-sync-progress') {
      (handler as ProgressHandler)({ payload: progress });
    }
  }
}

describe('global sync progress (#447)', () => {
  beforeEach(() => {
    eventMock.handlers.length = 0;
    eventMock.listen.mockReset();
    eventMock.listen.mockImplementation(async (event: string, handler: unknown) => {
      eventMock.handlers.push({ event, handler });
      return () => undefined;
    });
    cancelSyncMock.mockReset();
    __resetSyncProgressListenerForTests();
    useGlobalSyncStore.setState({
      isSyncing: false,
      source: null,
      progress: null,
      cancelRequested: false,
    });
  });

  it('registers the app-level progress listener only once', async () => {
    await Promise.all([ensureSyncProgressListener(), ensureSyncProgressListener()]);
    await ensureSyncProgressListener();
    expect(eventMock.listen).toHaveBeenCalledTimes(1);
  });

  it('beginSync seeds a preparing progress and the listener keeps it current', async () => {
    await ensureSyncProgressListener();
    expect(useGlobalSyncStore.getState().beginSync('test')).toBe(true);
    expect(useGlobalSyncStore.getState().progress?.phase).toBe('preparing');

    emit(uploading);
    expect(useGlobalSyncStore.getState().progress).toEqual(uploading);
  });

  it('ignores progress events when no sync is running', async () => {
    await ensureSyncProgressListener();
    emit(uploading);
    expect(useGlobalSyncStore.getState().progress).toBeNull();

    useGlobalSyncStore.getState().beginSync('test');
    useGlobalSyncStore.getState().endSync();
    emit(uploading);
    expect(useGlobalSyncStore.getState().progress).toBeNull();
  });

  it('endSync keeps a caller-supplied failure progress visible', async () => {
    await ensureSyncProgressListener();
    useGlobalSyncStore.getState().beginSync('test');
    emit(uploading);

    const failed = createFailedSyncProgress(
      useGlobalSyncStore.getState().progress,
      'boom',
    );
    useGlobalSyncStore.getState().endSync(failed);

    const state = useGlobalSyncStore.getState();
    expect(state.isSyncing).toBe(false);
    expect(state.progress).toMatchObject({ phase: 'failed', error: 'boom', percent: 40 });
  });

  it('retries listener registration after a failure', async () => {
    eventMock.listen.mockRejectedValueOnce(new Error('no tauri'));
    await ensureSyncProgressListener();
    await ensureSyncProgressListener();
    expect(eventMock.listen).toHaveBeenCalledTimes(2);
  });

  it('requestCancel marks the request and resets it when the backend has nothing to cancel', async () => {
    useGlobalSyncStore.getState().beginSync('test');

    cancelSyncMock.mockResolvedValueOnce(true);
    await useGlobalSyncStore.getState().requestCancel();
    expect(cancelSyncMock).toHaveBeenCalledTimes(1);
    expect(useGlobalSyncStore.getState().cancelRequested).toBe(true);

    // 新一轮同步复位取消标记
    useGlobalSyncStore.getState().endSync();
    useGlobalSyncStore.getState().beginSync('test');
    expect(useGlobalSyncStore.getState().cancelRequested).toBe(false);

    cancelSyncMock.mockResolvedValueOnce(false);
    await useGlobalSyncStore.getState().requestCancel();
    expect(useGlobalSyncStore.getState().cancelRequested).toBe(false);
  });

  it('requestCancel is a no-op when nothing is syncing', async () => {
    await useGlobalSyncStore.getState().requestCancel();
    expect(cancelSyncMock).not.toHaveBeenCalled();
  });
});
