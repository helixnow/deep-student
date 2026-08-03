import { describe, expect, it } from 'vitest';

import { WORKBENCH_MODE_SETTING_KEY } from '@/features/settings/components/workbenchMode';
import { shouldCloseBrowserForGateChange } from '../hooks/useBrowserSession';
import { BROWSER_SETTING_KEYS } from '../navigationPolicy';

describe('Browser settings gate cleanup', () => {
  it('closes for disabled Workbench and Browser gates', () => {
    expect(
      shouldCloseBrowserForGateChange('workbench:mode-changed', { enabled: false }),
    ).toBe(true);
    expect(
      shouldCloseBrowserForGateChange('workbench:settings-changed', {
        key: BROWSER_SETTING_KEYS.enabled,
        value: false,
      }),
    ).toBe(true);
    expect(
      shouldCloseBrowserForGateChange('workbench:settings-changed', {
        key: WORKBENCH_MODE_SETTING_KEY,
        value: 'false',
      }),
    ).toBe(true);
  });

  it('ignores enabled gates and unrelated settings', () => {
    expect(
      shouldCloseBrowserForGateChange('workbench:mode-changed', { enabled: true }),
    ).toBe(false);
    expect(
      shouldCloseBrowserForGateChange('workbench:settings-changed', {
        key: 'desktop.workbenchBrowserAgentControl',
        value: false,
      }),
    ).toBe(false);
  });
});
