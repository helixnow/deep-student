import { describe, expect, it } from 'vitest';

import { COMPOSER_PANEL_KEYS, createDefaultPanelStates } from '../common';

describe('composer panel registry', () => {
  it('does not expose image generation as a dedicated composer panel', () => {
    expect(COMPOSER_PANEL_KEYS).not.toContain('imageGen');
    expect(createDefaultPanelStates()).not.toHaveProperty('imageGen');
  });
});
