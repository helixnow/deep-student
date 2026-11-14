import type { ShellBridge } from '../host/kernel/api.ts';
import type { ShellWindowSnapshot, ShellWindowsService } from './api.ts';

function snapshot(value: unknown): ShellWindowSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid shell window snapshot: expected an object');
  const entry = value as Record<string, unknown>;
  if (typeof entry.label !== 'string' || typeof entry.isMain !== 'boolean' || typeof entry.focused !== 'boolean') {
    throw new Error('invalid shell window snapshot: expected label:string, isMain:boolean, focused:boolean');
  }
  return { label: entry.label, isMain: entry.isMain, focused: entry.focused };
}

/** A live query, not a Host lifecycle-event cache (late-loaded plugins must see existing windows). */
export function createShellWindows(shell: ShellBridge): ShellWindowsService {
  return {
    async listWindows() {
      const value = await shell.request('window.listWindows');
      if (!Array.isArray(value)) throw new Error('invalid shell window list: expected an array');
      return value.map(snapshot);
    },
    async getMainWindow() {
      const value = await shell.request('window.getMainWindow');
      return value === null ? null : snapshot(value);
    },
  };
}
