import type { ReactNode } from 'react';
import { useSyncExternalStore } from 'react';

/** What the workshop knows about one managed work; the manager uses it for version actions and history. */
export interface PluginManagerWork {
  readonly pluginId: string;
  readonly version: string;
  /** The version a rollback would reinstall; absent when the workshop retains none. */
  readonly previousVersion?: string;
  /** What the latest version changed, in the workshop's own words. */
  readonly changes: readonly string[];
}

/** P4 owns creations, progress and session actions; the manager only provides their mount points. */
export interface PluginManagerWorkshop {
  /** Open a new workshop conversation; `prompt` is put in the input box, never sent on the user's behalf. */
  onCreate(prompt?: string): void;
  onModify(pluginId: string): void;
  onRollback?(pluginId: string): Promise<void>;
  /** Managed works by plugin id. Optional: without it the manager offers no version actions. */
  works?(): Promise<readonly PluginManagerWork[]>;
  /** Reinstall the retained previous version of a managed work. */
  onRestorePrevious?(pluginId: string): Promise<void>;
  /** Export a managed work as a `.dstuplugin` file; resolves to where it was written, null when the user cancelled. */
  onExport?(pluginId: string): Promise<string | null | undefined>;
  /** 「在文件夹中显示」 for an exported file, where the platform can. */
  onReveal?(path: string): void;
  /** A workshop error in the user's words (the manager never shows raw `WORKSHOP_*` text). */
  describeError?(raw: string): string;
  /** Uninstall a managed work through the workshop (keeps the chat card and the workshop record in sync). */
  onUninstall?(pluginId: string): Promise<void>;
  /** Works waiting for the user; 「工坊创作记录」 opens by itself when there are any. */
  pending?(): Promise<readonly { pluginId: string; name: string; phase: string }[]>;
  creations: ReactNode;
}

let current: PluginManagerWorkshop | undefined;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const snapshot = () => current;

/** Root composition owns the real paired remote/session ports and revokes this binding with its owner. */
export function registerPluginManagerWorkshop(workshop: PluginManagerWorkshop): () => void {
  current = workshop;
  for (const listener of listeners) listener();
  return () => {
    if (current !== workshop) return;
    current = undefined;
    for (const listener of listeners) listener();
  };
}

export function usePluginManagerWorkshop(): PluginManagerWorkshop | undefined {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
