import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  registerDomainListener: vi.fn(),
  unlisteners: [] as Array<ReturnType<typeof vi.fn>>,
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }));
vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));
vi.mock('../domainEvents', () => ({
  collectDomainEntityIds: vi.fn(() => []),
  registerDomainListener: mocks.registerDomainListener,
}));
vi.mock('../visuals/agentFlash', () => ({
  agentFlash: vi.fn(),
  agentFlashMany: vi.fn(),
}));

import type { StageManagerApi } from '../types';
import { registerFinderDriver } from '../drivers/finderDriver';
import { registerFsrsDriver } from '../drivers/fsrsDriver';
import {
  __resetQbankDriverForTests,
  registerQbankDriver,
} from '../drivers/qbankDriver';
import { registerTodoDriver } from '../drivers/todoDriver';

const stage = {
  registerDriver: vi.fn(),
} as unknown as StageManagerApi;

beforeEach(() => {
  mocks.unlisteners.length = 0;
  mocks.registerDomainListener.mockReset();
  mocks.registerDomainListener.mockImplementation(() => {
    const unlisten = vi.fn();
    mocks.unlisteners.push(unlisten);
    return unlisten;
  });
});

afterEach(() => {
  __resetQbankDriverForTests();
});

describe.each([
  ['todo', registerTodoDriver, 'todo://changed'],
  ['files', registerFinderDriver, 'dstu:change'],
  ['fsrs', registerFsrsDriver, 'fsrs://changed'],
  ['qbank', registerQbankDriver, 'qbank://changed'],
] as const)('%s driver domain listener lifecycle', (_name, register, eventName) => {
  it('re-register disposes the old listener and the current disposer is idempotent', () => {
    const disposeFirst = register(stage);
    const firstUnlisten = mocks.unlisteners[0]!;

    const disposeSecond = register(stage);
    const secondUnlisten = mocks.unlisteners[1]!;

    expect(mocks.registerDomainListener).toHaveBeenNthCalledWith(
      1,
      eventName,
      expect.any(Function),
    );
    expect(mocks.registerDomainListener).toHaveBeenNthCalledWith(
      2,
      eventName,
      expect.any(Function),
    );
    expect(firstUnlisten).toHaveBeenCalledTimes(1);

    disposeFirst();
    expect(firstUnlisten).toHaveBeenCalledTimes(1);

    disposeSecond();
    disposeSecond();
    expect(secondUnlisten).toHaveBeenCalledTimes(1);
  });
});
