import { beforeEach, describe, expect, it, vi } from 'vitest';

const { registerDomainListener } = vi.hoisted(() => ({
  registerDomainListener: vi.fn(),
}));

vi.mock('@/features/workbench/agent/domainEvents', () => ({
  registerDomainListener,
}));

import { registerMemoryDomainRefresh } from '../memoryDomainRefresh';

describe('MemoryView domain refresh', () => {
  beforeEach(() => {
    registerDomainListener.mockReset();
  });

  it('refreshes both list and tree for memory://changed and returns cleanup', async () => {
    const cleanup = vi.fn();
    const refreshList = vi.fn(async () => {});
    const refreshTree = vi.fn(async () => {});
    registerDomainListener.mockReturnValue(cleanup);

    const result = registerMemoryDomainRefresh(refreshList, refreshTree);

    expect(registerDomainListener).toHaveBeenCalledTimes(1);
    expect(registerDomainListener).toHaveBeenCalledWith(
      'memory://changed',
      expect.any(Function),
    );
    const handler = registerDomainListener.mock.calls[0][1] as () => void;
    handler();
    await Promise.resolve();

    expect(refreshList).toHaveBeenCalledTimes(1);
    expect(refreshTree).toHaveBeenCalledTimes(1);
    expect(result).toBe(cleanup);
  });
});
