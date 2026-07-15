import { describe, expect, it, vi } from 'vitest';

import { persistBrowserNetworkModeSelection } from '../browserNetworkModePersistence';

describe('persistBrowserNetworkModeSelection', () => {
  it('keeps the selected mode after persistence succeeds', async () => {
    const apply = vi.fn();
    const persist = vi.fn().mockResolvedValue(true);

    await expect(
      persistBrowserNetworkModeSelection({
        previous: 'local_whitelist',
        next: 'full',
        persist,
        apply,
      }),
    ).resolves.toBe(true);

    expect(persist).toHaveBeenCalledWith('full');
    expect(apply.mock.calls).toEqual([['full']]);
  });

  it('restores the previous mode after persistence fails', async () => {
    const apply = vi.fn();
    const persist = vi.fn().mockResolvedValue(false);

    await expect(
      persistBrowserNetworkModeSelection({
        previous: 'full',
        next: 'local_whitelist',
        persist,
        apply,
      }),
    ).resolves.toBe(false);

    expect(apply.mock.calls).toEqual([['local_whitelist'], ['full']]);
  });
});
