import { describe, expect, it, vi } from 'vitest';

import {
  MARKDOWN_INITIAL_LINE_WINDOW_SETTING,
  loadInitialLineWindowSetting,
  saveInitialLineWindowSetting,
  type InvokeLike,
} from '@/features/notes/markdownWindowSettings';

describe('markdownWindowSettings helpers', () => {
  it('loads the persisted initial line window setting', async () => {
    const invokeFn = vi.fn<InvokeLike>(async () => '750');

    await expect(loadInitialLineWindowSetting(invokeFn)).resolves.toBe(750);
    expect(invokeFn).toHaveBeenCalledWith('get_setting', {
      key: MARKDOWN_INITIAL_LINE_WINDOW_SETTING,
    });
  });

  it('falls back to the default for missing, invalid, rejected, zero, and negative values', async () => {
    await expect(loadInitialLineWindowSetting(vi.fn<InvokeLike>(async () => null))).resolves.toBe(600);
    await expect(loadInitialLineWindowSetting(vi.fn<InvokeLike>(async () => 'invalid'))).resolves.toBe(600);
    await expect(loadInitialLineWindowSetting(vi.fn<InvokeLike>(async () => '0'))).resolves.toBe(600);
    await expect(loadInitialLineWindowSetting(vi.fn<InvokeLike>(async () => '-10'))).resolves.toBe(600);
    await expect(loadInitialLineWindowSetting(vi.fn<InvokeLike>(async () => {
      throw new Error('rejects');
    }))).resolves.toBe(600);
  });

  it('clamps loaded persisted values to safe bounds', async () => {
    await expect(loadInitialLineWindowSetting(vi.fn<InvokeLike>(async () => '50'))).resolves.toBe(100);
    await expect(loadInitialLineWindowSetting(vi.fn<InvokeLike>(async () => '999999'))).resolves.toBe(5000);
  });

  it('saves the clamped value through the shared setting key', async () => {
    const invokeFn = vi.fn<InvokeLike>(async () => undefined);

    await expect(saveInitialLineWindowSetting(750, invokeFn)).resolves.toBe(750);
    expect(invokeFn).toHaveBeenCalledWith('save_setting', {
      key: 'notes.editor.initial_line_window',
      value: '750',
    });

    await expect(saveInitialLineWindowSetting(999999, invokeFn)).resolves.toBe(5000);
    expect(invokeFn).toHaveBeenLastCalledWith('save_setting', {
      key: 'notes.editor.initial_line_window',
      value: '5000',
    });
  });
});
