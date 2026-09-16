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


describe('gate change value normalization', () => {
  it.each([null, undefined, false, 0, '0', '', 'off', 'no', ' FALSE '])(
    'closes for a disabled child gate value: %j', (value) => {
      expect(shouldCloseBrowserForGateChange('workbench:settings-changed', {
        key: BROWSER_SETTING_KEYS.enabled, value,
      })).toBe(true);
    },
  );

  it.each([true, 1, 'true', '1', 'yes', 'on', ' YES '])(
    'preserves the browser for an enabled child gate value: %j', (value) => {
      expect(shouldCloseBrowserForGateChange('workbench:settings-changed', {
        key: BROWSER_SETTING_KEYS.enabled, value,
      })).toBe(false);
    },
  );

  it.each([null, undefined, 'invalid'])('preserves the parent gate default for %j', (value) => {
    expect(shouldCloseBrowserForGateChange('workbench:settings-changed', {
      key: WORKBENCH_MODE_SETTING_KEY, value,
    })).toBe(false);
  });
});
