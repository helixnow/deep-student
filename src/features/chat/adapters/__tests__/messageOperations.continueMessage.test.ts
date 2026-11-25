import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { continueMessage } from '../tauri/messageOperations';
import type { TauriAdapterHost } from '../tauri/adapterHost';
import { adapterConsole } from '../tauri/diagnostics';
import { reportAdapterError } from '../errors/adapterErrorChannel';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('../../core/middleware/eventBridge', () => ({ resetBridgeState: vi.fn() }));
vi.mock('../../core/session/sessionManager', () => ({ sessionManager: { get: vi.fn() } }));
vi.mock('../errors/adapterErrorChannel', () => ({ reportAdapterError: vi.fn() }));

function createHost(): TauriAdapterHost {
  return {
    sessionId: 'sess_continue',
    store: {
      setCurrentStreamingMessage: vi.fn(),
      completeStream: vi.fn(),
    },
    storeApi: {
      setState: vi.fn(),
    },
    getErrorStoreApi: vi.fn(() => ({ setState: vi.fn() })),
    getCurrentState: () => ({ chatParams: { modelId: 'model_continue' } }),
    ensureModelMetadataReady: vi.fn().mockResolvedValue(undefined),
    buildSendOptions: vi.fn().mockResolvedValue({ modelId: 'model_continue' }),
    applyOriginalReplaySkillState: (_id: string, options: unknown) => options,
    applyRuntimeModelSelection: vi.fn().mockResolvedValue(undefined),
    beginStreamExpectation: vi.fn(),
    setStreamExpectationMessageId: vi.fn(),
    clearStreamExpectation: vi.fn(),
  } as unknown as TauriAdapterHost;
}

describe('messageOperations continueMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not emit console.error on TODO fallback and completes stream cleanly', async () => {
    const errorSpy = vi.spyOn(adapterConsole, 'error').mockImplementation(() => {});
    const debugSpy = vi.spyOn(adapterConsole, 'debug').mockImplementation(() => {});
    vi.mocked(invoke).mockRejectedValueOnce(new Error('No incomplete TODO list found. Cannot continue execution.'));

    const host = createHost();
    await expect(continueMessage(host, 'msg_a1')).rejects.toThrow('No incomplete TODO list found');

    expect(errorSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalled();
    expect(host.store.completeStream).toHaveBeenCalledWith('success');
    expect(host.store.setCurrentStreamingMessage).toHaveBeenLastCalledWith(null);
    expect(reportAdapterError).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it('logs console.error and reports genuine continue failures to UI error state', async () => {
    const errorSpy = vi.spyOn(adapterConsole, 'error').mockImplementation(() => {});
    vi.mocked(invoke).mockRejectedValueOnce(new Error('Database error: disk full'));

    const host = createHost();
    await expect(continueMessage(host, 'msg_a1')).rejects.toThrow('Database error: disk full');

    expect(errorSpy).toHaveBeenCalled();
    expect(host.store.completeStream).toHaveBeenCalledWith('error', expect.stringContaining('disk full'));
    expect(reportAdapterError).toHaveBeenCalledWith(expect.objectContaining({
      code: 'stream_error',
      level: 'user',
      sessionId: 'sess_continue',
      notify: false,
    }));

    errorSpy.mockRestore();
  });
});
