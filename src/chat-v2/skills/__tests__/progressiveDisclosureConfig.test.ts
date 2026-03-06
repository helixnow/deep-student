import { describe, expect, it } from 'vitest';

import { DEFAULT_PROGRESSIVE_DISCLOSURE_CONFIG, getProgressiveDisclosureConfig } from '../progressiveDisclosure';

describe('progressive disclosure defaults', () => {
  it('does not auto-load skills by default', () => {
    expect(DEFAULT_PROGRESSIVE_DISCLOSURE_CONFIG.autoLoadSkills).toEqual([]);
    expect(getProgressiveDisclosureConfig().autoLoadSkills).toEqual([]);
  });
});
