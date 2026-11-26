/**
 * Chat V2 - Declarative Study Pack (`.dspack`) Workflow Slash Bridge
 *
 * Automatically surfaces `declarative.workflows` from enabled `.dspack` packages
 * as slash commands inside the chat composer (`category: 'plugin'`), refreshing
 * whenever `host://ui-manifest-v2` fires.
 */

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

export interface DeclarativePackWorkflowItem {
  /** Normalized slash command token (without `/`), e.g. `kaoyan-reading` */
  commandName: string;
  /** Human-readable workflow title */
  workflowTitle: string;
  /** Owning `.dspack` display name or ID */
  packName: string;
  pluginId: string;
}

interface RawPluginListResponse {
  plugins?: Array<{
    id?: string;
    displayName?: string;
    enabled?: boolean;
    declarative?: {
      workflows?: readonly string[];
    };
  }>;
}

const VALID_CMD_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function normalizeWorkflowCommandName(
  pluginId: string,
  workflowRaw: string,
  index: number,
  usedNames: Set<string>,
): string {
  const asciiSlug = workflowRaw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const pluginSlug = pluginId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'pack';

  const base = asciiSlug && VALID_CMD_RE.test(asciiSlug)
    ? asciiSlug
    : `${pluginSlug}-wf-${index + 1}`;

  let candidate = base;
  let suffix = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

export async function fetchDeclarativePackWorkflows(): Promise<DeclarativePackWorkflowItem[]> {
  try {
    const inv = await invoke<RawPluginListResponse>('plugin:manager|list', {});
    if (!inv || !Array.isArray(inv.plugins)) return [];

    const usedNames = new Set<string>();
    const items: DeclarativePackWorkflowItem[] = [];
    for (const plugin of inv.plugins) {
      if (!plugin || !plugin.enabled || typeof plugin.id !== 'string') continue;
      const workflows = plugin.declarative?.workflows;
      if (!Array.isArray(workflows) || workflows.length === 0) continue;

      const packName = (plugin.displayName || plugin.id).trim();
      workflows.forEach((wf, idx) => {
        if (typeof wf !== 'string' || !wf.trim()) return;
        const workflowTitle = wf.trim();
        const commandName = normalizeWorkflowCommandName(plugin.id!, workflowTitle, idx, usedNames);
        items.push({
          commandName,
          workflowTitle,
          packName,
          pluginId: plugin.id!,
        });
      });
    }
    return items;
  } catch {
    return [];
  }
}

export function useDeclarativePackWorkflows(enabled: boolean): DeclarativePackWorkflowItem[] {
  const [workflows, setWorkflows] = useState<DeclarativePackWorkflowItem[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const refresh = () => {
      void fetchDeclarativePackWorkflows().then((next) => {
        if (!cancelled) setWorkflows(next);
      });
    };

    refresh();

    let unlisten: (() => void) | null = null;
    import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen('host://ui-manifest-v2', () => {
          refresh();
        }),
      )
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // Non-Tauri / unit test environment
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [enabled]);

  return workflows;
}
