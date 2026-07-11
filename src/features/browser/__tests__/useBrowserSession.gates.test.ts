import { describe, expect, it } from 'vitest';

import { shouldCloseBrowserForGateChange } from '../hooks/useBrowserSession';

describe('Browser settings gate cleanup', () => {
  it('closes for disabled Workbench and Browser gates', () => {
    expect(
      shouldCloseBrowserForGateChange('workbench:mode-changed', { enabled: false }),
    ).toBe(true);
    expect(
      shouldCloseBrowserForGateChange('workbench:settings-changed', {
        key: 'desktop.workbenchBrowserEnabled',
        value: false,
      }),
    ).toBe(true);
    expect(
      shouldCloseBrowserForGateChange('workbench:settings-changed', {
        key: 'desktop.workbenchMode',
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
