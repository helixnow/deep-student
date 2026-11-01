import { describe, expect, it } from 'vitest';
import { pinnedVendorRank, sortVendorsBySettingsOrder } from '../modelSorting';

describe('sortVendorsBySettingsOrder', () => {
  it('pins SiliconFlow first and OpenCode Go second, then follows sortOrder', () => {
    const vendors = [
      { id: 'a', name: 'Anthropic', providerType: 'anthropic', sortOrder: 0 },
      { id: 'go', name: 'OpenCode Go', providerType: 'opencode_go', sortOrder: 9 },
      { id: 'b', name: 'DeepSeek', providerType: 'deepseek', sortOrder: 1 },
      { id: 'sf', name: 'SiliconFlow', providerType: 'siliconflow', sortOrder: 5 },
    ];
    expect(sortVendorsBySettingsOrder(vendors).map((v) => v.id)).toEqual(['sf', 'go', 'a', 'b']);
  });

  it('ranks unknown provider types after the pinned ones', () => {
    expect(pinnedVendorRank('SiliconFlow')).toBe(0);
    expect(pinnedVendorRank('opencode_go')).toBe(1);
    expect(pinnedVendorRank(undefined)).toBe(2);
  });
});
