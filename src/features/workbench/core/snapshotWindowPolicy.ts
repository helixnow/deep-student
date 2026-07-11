import type { WorkbenchWindow } from './types';

/**
 * Chat 从 multi 迁移为 single 后，旧快照可能仍含多个窗口。
 * 恢复时只保留最近使用的一个，并移除已不再代表窗口身份的 session instanceKey。
 */
export function normalizeSingletonAppWindows(windows: WorkbenchWindow[]): WorkbenchWindow[] {
  const chatWindows = windows.filter((win) => win.typeId === 'chat');
  if (chatWindows.length === 0) return windows;

  const keeper = chatWindows.reduce((latest, candidate) => {
    if (candidate.lastFocusedAt !== latest.lastFocusedAt) {
      return candidate.lastFocusedAt > latest.lastFocusedAt ? candidate : latest;
    }
    return candidate.createdAt > latest.createdAt ? candidate : latest;
  });

  return windows.flatMap((win) => {
    if (win.typeId !== 'chat') return [win];
    return win.id === keeper.id ? [{ ...win, instanceKey: null }] : [];
  });
}
