/** UI domain contract. Wire commands belong in the Host adapter, never in components. */
export type WorkshopPhase = 'proposed' | 'ready' | 'generating' | 'validating' | 'installing' | 'installed' | 'disabled' | 'undone' | 'cancelled' | 'failed';

export interface WorkshopItem {
  id: string;
  proposalId: string;
  revision?: number;
  name: string;
  version: string;
  previousVersion?: string;
  description?: string;
  capabilities: string[];
  changes: string[];
  trust: 'full' | 'restricted';
  phase: WorkshopPhase;
  progress?: string;
  error?: string;
  /** Set only when Host confirms the previous usable version was restored. */
  rollback?: 'restored' | 'failed' | 'not-needed';
  visualVerified: boolean;
}

export type WorkshopAction = 'confirm' | 'cancel' | 'try' | 'disable' | 'undo' | 'restore' | 'export';

export interface WorkshopAdapter {
  list(): Promise<WorkshopItem[]>;
  get(proposalId: string): Promise<WorkshopItem>;
  /** Implementations must bind consent to this exact proposal/version. */
  act(action: WorkshopAction, item: WorkshopItem): Promise<{ item: WorkshopItem; exportPath?: string }>;
  subscribe(onChange: () => void): () => void;
}

export function workshopActions(phase: WorkshopPhase): WorkshopAction[] {
  switch (phase) {
    case 'proposed': return ['confirm', 'cancel'];
    case 'ready': return ['confirm'];
    case 'generating':
    case 'validating': return ['cancel'];
    case 'installed': return ['try', 'disable', 'undo', 'export'];
    case 'disabled': return ['try', 'undo', 'export'];
    case 'undone': return ['restore', 'export'];
    default: return [];
  }
}
