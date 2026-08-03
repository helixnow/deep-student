import { describe, expect, it, vi } from 'vitest';
import {
  SubagentIdleWakeController,
  type ParentWakeState,
  type ParentWakeStore,
} from '../subagentIdleWake';

function createParentStore(initial: ParentWakeState): ParentWakeStore & {
  setState(state: ParentWakeState): void;
} {
  let state = initial;
  const listeners = new Set<(next: ParentWakeState) => void>();
  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setState: (next) => {
      state = next;
      for (const listener of listeners) listener(next);
    },
  };
}

const completion = (overrides = {}) => ({
  workspace_id: 'workspace-1',
  parent_session_id: 'parent-1',
  agent_session_id: 'agent-1',
  task_id: 'task-1',
  run_id: 'run-1',
  status: 'completed',
  ...overrides,
});

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('SubagentIdleWakeController', () => {
  it('retains a busy completion and wakes after parent becomes idle', async () => {
    const store = createParentStore({
      sessionStatus: 'streaming',
      currentStreamingMessageId: 'msg-1',
    });
    const sendWake = vi.fn().mockResolvedValue(true);
    const controller = new SubagentIdleWakeController({
      resolveParentStore: async () => store,
      sendWake,
    });

    controller.enqueue(completion());
    await flush();
    expect(sendWake).not.toHaveBeenCalled();

    store.setState({ sessionStatus: 'idle', currentStreamingMessageId: null });
    await flush();
    expect(sendWake).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('serializes two completions for the same parent', async () => {
    const store = createParentStore({ sessionStatus: 'idle', currentStreamingMessageId: null });
    let finishFirst: (() => void) | undefined;
    const firstSent = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const sendWake = vi.fn()
      .mockImplementationOnce(async () => {
        await firstSent;
        return true;
      })
      .mockResolvedValueOnce(true);
    const controller = new SubagentIdleWakeController({
      resolveParentStore: async () => store,
      sendWake,
    });

    controller.enqueue(completion({ run_id: 'run-1' }));
    controller.enqueue(completion({ run_id: 'run-2', task_id: 'task-2' }));
    await flush();
    expect(sendWake).toHaveBeenCalledTimes(1);

    finishFirst?.();
    await flush();
    expect(sendWake).toHaveBeenCalledTimes(2);
    expect(sendWake.mock.calls.map(([payload]) => payload.run_id)).toEqual(['run-1', 'run-2']);
    controller.dispose();
  });

  it('does not enqueue an identical wake key twice', async () => {
    const store = createParentStore({
      sessionStatus: 'streaming',
      currentStreamingMessageId: 'msg-1',
    });
    const sendWake = vi.fn().mockResolvedValue(true);
    const controller = new SubagentIdleWakeController({
      resolveParentStore: async () => store,
      sendWake,
    });
    const payload = completion();

    controller.enqueue(payload);
    controller.enqueue(payload);
    await flush();
    store.setState({ sessionStatus: 'idle', currentStreamingMessageId: null });
    await flush();

    expect(sendWake).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('abandons an unavailable parent after the lookup retry limit', async () => {
    vi.useFakeTimers();
    const resolveParentStore = vi.fn().mockResolvedValue(undefined);
    const sendWake = vi.fn().mockResolvedValue(true);
    const controller = new SubagentIdleWakeController({
      resolveParentStore,
      sendWake,
    });

    controller.enqueue(completion());
    await vi.advanceTimersByTimeAsync(120_000);

    expect(resolveParentStore).toHaveBeenCalledTimes(120);
    expect(sendWake).not.toHaveBeenCalled();

    controller.enqueue(completion());
    await flush();
    expect(resolveParentStore).toHaveBeenCalledTimes(120);
    controller.dispose();
    vi.useRealTimers();
  });

  it('clears queued wakes when its workspace closes', async () => {
    const store = createParentStore({
      sessionStatus: 'streaming',
      currentStreamingMessageId: 'msg-1',
    });
    const sendWake = vi.fn().mockResolvedValue(true);
    const controller = new SubagentIdleWakeController({
      resolveParentStore: async () => store,
      sendWake,
    });

    controller.enqueue(completion());
    await flush();
    controller.clearWorkspace('workspace-1');
    store.setState({ sessionStatus: 'idle', currentStreamingMessageId: null });
    await flush();

    expect(sendWake).not.toHaveBeenCalled();
    controller.dispose();
  });
});
