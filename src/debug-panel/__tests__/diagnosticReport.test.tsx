/**
 * FE-B7: the Crepe image upload panel's "诊断报告" copies the raw runtime environment (navigator.userAgent /
 * navigator.platform as is, not a platform classification) next to the logs.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { debugMasterSwitch } from '../debugMasterSwitch';

const h = vi.hoisted(() => ({ copied: [] as string[] }));

vi.mock('@/utils/clipboardUtils', () => ({
  copyTextToClipboard: vi.fn(async (text: string) => {
    h.copied.push(text);
    return true;
  }),
}));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));

const props = { visible: true, isActive: true, isActivated: true, isActivatedInitially: true, onClose: () => undefined };

beforeAll(() => {
  debugMasterSwitch.enable();
  Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) DeepStudentProbe/1.0' });
  Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'MacIntel' });
});

afterAll(() => {
  debugMasterSwitch.disable();
  // The overrides are own properties; deleting them uncovers jsdom's Navigator.prototype getters again.
  delete (navigator as unknown as Record<string, unknown>).userAgent;
  delete (navigator as unknown as Record<string, unknown>).platform;
});

afterEach(() => {
  cleanup();
  h.copied.length = 0;
});

describe('Crepe image upload diagnostic report (FE-B7)', () => {
  it('records navigator.userAgent and navigator.platform verbatim', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { default: Panel } = await import('../plugins/CrepeImageUploadDebugPlugin');
    await act(async () => {
      render(<Panel {...props} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle('复制完整诊断报告'));
    });
    expect(h.copied).toHaveLength(1);
    const report = JSON.parse(h.copied[0]!);
    expect(Object.keys(report)).toEqual(['timestamp', 'environment', 'lastSnapshot', 'logsCount', 'errorCount', 'warningCount', 'logs']);
    expect(report.environment).toEqual({
      isTauri: false,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) DeepStudentProbe/1.0',
      platform: 'MacIntel',
    });
  });
});
