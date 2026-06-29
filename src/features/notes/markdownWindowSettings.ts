import { invoke } from '@tauri-apps/api/core';

import { clampInitialLineWindow } from './markdownWindow';

export const MARKDOWN_INITIAL_LINE_WINDOW_SETTING = 'notes.editor.initial_line_window';

export type InvokeLike = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export async function loadInitialLineWindowSetting(
  invokeFn: InvokeLike = invoke,
): Promise<number> {
  try {
    const value = await invokeFn<string | null>('get_setting', {
      key: MARKDOWN_INITIAL_LINE_WINDOW_SETTING,
    });
    return clampInitialLineWindow(value);
  } catch {
    return clampInitialLineWindow(undefined);
  }
}

export async function saveInitialLineWindowSetting(
  value: unknown,
  invokeFn: InvokeLike = invoke,
): Promise<number> {
  const clamped = clampInitialLineWindow(value);
  await invokeFn('save_setting', {
    key: MARKDOWN_INITIAL_LINE_WINDOW_SETTING,
    value: String(clamped),
  });
  return clamped;
}
