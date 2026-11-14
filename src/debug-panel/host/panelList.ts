/**
 * Analysis Panel host: which panels exist (the `debug.panels` slot, or the announcements without a UI kernel) and the
 * home screen groups they are listed under.
 */
import React from 'react';
import { useOptionalSlot, type UiPluginScopeValue } from '@/ui-kernel/react';
import {
  subscribeUnattachedDebugPanels,
  unattachedDebugPanels,
  type DebugPanel,
} from '@/ui-plugins/official/debug/api';

export const HOME_PLUGIN_ID = 'home';

type PluginGroup = {
  id: string;
  labelKey: string;
  descriptionKey: string;
};

export type DebugPanelItem = DebugPanel & { community?: UiPluginScopeValue };

/** `debug.panels` in slot order (first entry wins per id); the announcements directly when there is no UI kernel. */
export function useDebugPanels(): readonly DebugPanelItem[] {
  const entries = useOptionalSlot('debug.panels');
  const unattached = React.useSyncExternalStore(subscribeUnattachedDebugPanels, unattachedDebugPanels);
  return React.useMemo(() => {
    if (!entries) return unattached;
    const seen = new Set<string>();
    return entries
      .filter((entry) => !seen.has(entry.id) && !!seen.add(entry.id))
      .map((entry) => (entry.origin === 'builtin' ? entry.value : { ...entry.value, id: entry.id, community: { id: entry.owner, origin: entry.origin } }));
  }, [entries, unattached]);
}

export const PLUGIN_GROUPS: PluginGroup[] = [
  {
    id: 'chat-timeline',
    labelKey: 'debug_panel.group.chat_timeline.title',
    descriptionKey: 'debug_panel.group.chat_timeline.desc',
  },
  {
    id: 'exam-workflow',
    labelKey: 'debug_panel.group.exam_workflow.title',
    descriptionKey: 'debug_panel.group.exam_workflow.desc',
  },
  {
    id: 'cards-template',
    labelKey: 'debug_panel.group.cards_template.title',
    descriptionKey: 'debug_panel.group.cards_template.desc',
  },
  {
    id: 'graph-research',
    labelKey: 'debug_panel.group.graph_research.title',
    descriptionKey: 'debug_panel.group.graph_research.desc',
  },
  {
    id: 'input-pipeline',
    labelKey: 'debug_panel.group.input_pipeline.title',
    descriptionKey: 'debug_panel.group.input_pipeline.desc',
  },
  {
    id: 'notes-editor',
    labelKey: 'debug_panel.group.notes_editor.title',
    descriptionKey: 'debug_panel.group.notes_editor.desc',
  },
  {
    id: 'infra-quality',
    labelKey: 'debug_panel.group.infra_quality.title',
    descriptionKey: 'debug_panel.group.infra_quality.desc',
  },
];
