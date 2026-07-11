import { describe, expect, it, vi } from 'vitest';
import {
  preheatSubagentSession,
  shouldPreheatSubagentSession,
} from '../sessionPreheat';

function createDependencies(options?: { loaded?: boolean }) {
  const loadSession = vi.fn(() => Promise.resolve());
  const store = {
    getState: () => ({
      isDataLoaded: options?.loaded ?? false,
      loadSession,
    }),
  };
  const lease = { sessionId: 'agent_test', generation: 1 };
  const adapterManager = {
    getOrCreate: vi.fn(() => Promise.resolve({
      entry: { isReady: true },
      lease,
    })),
    release: vi.fn(),
  };
  return {
    dependencies: {
      getStore: vi.fn(() => store),
      adapterManager,
    } as any,
    adapterManager,
    loadSession,
    lease,
  };
}

describe('subagent session preheat', () => {
  it('releases the temporary lease immediately after load succeeds', async () => {
    const { dependencies, adapterManager, loadSession, lease } = createDependencies();

    await preheatSubagentSession('agent_test', () => false, dependencies);

    expect(loadSession).toHaveBeenCalledWith('agent_test');
    expect(adapterManager.release).toHaveBeenCalledOnce();
    expect(adapterManager.release).toHaveBeenCalledWith('agent_test', lease);
  });

  it('releases once when cancellation happens before acquisition resolves', async () => {
    const { dependencies, adapterManager, loadSession, lease } = createDependencies();
    let resolveAcquisition!: (value: any) => void;
    adapterManager.getOrCreate.mockReturnValueOnce(new Promise((resolve) => {
      resolveAcquisition = resolve;
    }));
    let cancelled = false;

    const preheat = preheatSubagentSession(
      'agent_test',
      () => cancelled,
      dependencies,
    );
    await vi.waitFor(() => expect(adapterManager.getOrCreate).toHaveBeenCalledOnce());
    cancelled = true;
    resolveAcquisition({ entry: { isReady: true }, lease });
    await preheat;

    expect(loadSession).not.toHaveBeenCalled();
    expect(adapterManager.release).toHaveBeenCalledOnce();
    expect(adapterManager.release).toHaveBeenCalledWith('agent_test', lease);
  });

  it('releases the lease when load fails', async () => {
    const { dependencies, adapterManager, loadSession } = createDependencies();
    loadSession.mockRejectedValueOnce(new Error('load failed'));

    await expect(
      preheatSubagentSession('agent_test', () => false, dependencies),
    ).rejects.toThrow('load failed');

    expect(adapterManager.release).toHaveBeenCalledOnce();
  });

  it('keeps collapsed subagent embeds out of the preheat path', () => {
    expect(shouldPreheatSubagentSession('agent_test', true)).toBe(false);
    expect(shouldPreheatSubagentSession('agent_test', false)).toBe(true);
    expect(shouldPreheatSubagentSession(undefined, false)).toBe(false);
  });
});

