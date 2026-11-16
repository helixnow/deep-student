import { useSyncExternalStore } from 'react';
import type { WorkshopPhase, WorkshopProgress } from './types';

/**
 * The live stage of each workshop card, shared between the card body (which polls the Host) and the chat tool
 * header (which shows 「等你确认」/「正在做」/「已安装」 instead of a generic "done + duration").
 */
export interface WorkshopStage { phase: WorkshopPhase; progress?: WorkshopProgress; /** plugin_manager key of the stage label */ labelKey?: string }

const stages = new Map<string, WorkshopStage>();
const listeners = new Set<() => void>();

export function publishWorkshopStage(proposalId: string, stage: WorkshopStage): void {
  const current = stages.get(proposalId);
  if (current && current.phase === stage.phase && current.labelKey === stage.labelKey && JSON.stringify(current.progress) === JSON.stringify(stage.progress)) return;
  stages.set(proposalId, stage);
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function useWorkshopStage(proposalId: string | undefined): WorkshopStage | undefined {
  return useSyncExternalStore(subscribe, () => (proposalId ? stages.get(proposalId) : undefined), () => undefined);
}

/** Wire state of a persisted tool output, before the card has read the Host. */
export function phaseOfWireState(state: unknown): WorkshopPhase | undefined {
  switch (state) {
    case 'draft': return 'proposed';
    case 'generating': return 'generating';
    case 'pending-confirmation': return 'ready';
    case 'installed': return 'installed';
    case 'failed': return 'failed';
    case 'revoked': return 'undone';
    case 'cancelled': return 'cancelled';
    case 'superseded': return 'superseded';
    default: return undefined;
  }
}
