import type { WorkshopAction, WorkshopAdapter, WorkshopItem, WorkshopPhase } from './types';

/** P3 workshop.md v1 wire contract. Kept separate from display state. */
export interface WorkshopCard {
  kind: 'dstu-plugin-workshop'; id: string; pluginId: string; sessionId: string;
  title: string; description: string; template: 'learning-tool' | 'host-tool';
  state: 'draft' | 'generating' | 'cancelled' | 'pending-confirmation' | 'installed' | 'failed' | 'revoked';
  revision: number; version: string | null; capabilities: string[]; changes: string[];
  trust: 'full'; source: 'workshop'; risk: string;
  check: { ok: boolean; manifest: 'passed' | 'failed'; compile: 'passed' | 'failed'; lifecycle: 'passed' | 'failed' | 'not-run'; visual: 'not-verified'; errors: string[] } | null;
  error: string | null; previousVersion: string | null; createdAt: string; updatedAt: string;
  rollback?: 'not-needed' | 'restored' | 'failed';
  buildAttempt?: number;
}

/** Must be supplied by the real paired dstu.plugin-workshop UI context. */
export interface WorkshopRemote {
  reportFault?(id: string, error: string): Promise<WorkshopCard>;
  bindSession(id: string, revision: number, sessionId: string): Promise<WorkshopCard>;
  list(): Promise<WorkshopCard[]>;
  status(id: string): Promise<WorkshopCard>;
  create(id: string, revision: number): Promise<WorkshopCard>;
  cancel(id: string, revision: number): Promise<WorkshopCard>;
  install(id: string, revision: number): Promise<WorkshopCard>;
  revoke(id: string, revision: number): Promise<WorkshopCard>;
  restore(id: string, revision: number): Promise<WorkshopCard>;
  export(id: string): Promise<{ id: string; version: string; path: string }>;
}

export interface WorkshopManagerPort {
  list(): Promise<{ plugins: readonly { id: string; enabled: boolean; state?: string; reason?: string }[] }>;
  setEnabled(id: string, enabled: boolean): Promise<{ ok: true } | { ok: false; code: string; detail?: string }>;
}

const phases: Record<WorkshopCard['state'], WorkshopPhase> = {
  draft: 'proposed', generating: 'generating', cancelled: 'cancelled',
  'pending-confirmation': 'ready', installed: 'installed', failed: 'failed', revoked: 'undone',
};

export function workshopItem(card: WorkshopCard, enabled?: boolean, degradedReason?: string): WorkshopItem {
  return {
    id: card.pluginId, proposalId: card.id, revision: card.revision, name: card.title,
    version: card.version ?? '待生成', previousVersion: card.previousVersion ?? undefined,
    description: card.description, capabilities: card.capabilities, changes: card.changes, trust: card.trust,
    phase: card.state === 'installed' && (enabled === false || degradedReason !== undefined) ? 'disabled' : phases[card.state],
    error: degradedReason ?? card.error ?? undefined, rollback: card.rollback, visualVerified: false,
    progress: card.state === 'generating' ? `自动编译与修复 · 第 ${card.buildAttempt ?? 1}/3 次尝试` : undefined,
  };
}

export class HostWorkshopAdapter implements WorkshopAdapter {
  constructor(
    private readonly remote: WorkshopRemote,
    private readonly manager: WorkshopManagerPort,
    private readonly onOpenPlugin?: (pluginId: string) => void | Promise<void>,
  ) {}

  private item(card: WorkshopCard, inventory: Awaited<ReturnType<WorkshopManagerPort['list']>>): WorkshopItem {
    const plugin = inventory.plugins.find(entry => entry.id === card.pluginId);
    return workshopItem(card, plugin?.enabled, plugin?.state === 'degraded' ? plugin.reason : undefined);
  }

  async list(): Promise<WorkshopItem[]> {
    const [cards, inventory] = await Promise.all([this.remote.list(), this.manager.list()]);
    return cards.map(card => this.item(card, inventory));
  }

  async get(id: string): Promise<WorkshopItem> {
    const [card, inventory] = await Promise.all([this.remote.status(id), this.manager.list()]);
    return this.item(card, inventory);
  }

  subscribe(listener: () => void): () => void {
    // P3 exposes authoritative status reads, not a progress event. Stop polling on unmount.
    const timer = setInterval(listener, 2000);
    return () => clearInterval(timer);
  }

  async act(action: WorkshopAction, item: WorkshopItem) {
    const id = item.proposalId;
    if (action === 'export') {
      const exported = await this.remote.export(id);
      return { item: await this.get(id), exportPath: exported.path };
    }
    if (action === 'try' || action === 'disable') {
      const result = await this.manager.setEnabled(item.id, action === 'try');
      if (result.ok === false) throw new Error(result.detail ?? result.code);
      const updated = await this.get(id);
      if (action === 'try') await this.onOpenPlugin?.(item.id);
      return { item: updated };
    }
    if (item.revision === undefined) throw new Error('WORKSHOP_CONFLICT: 请刷新确认卡片');
    // Do not read a fresh revision here: consent belongs to the candidate displayed to the user.
    switch (action) {
      case 'confirm':
        if (item.phase === 'proposed') await this.remote.create(id, item.revision);
        else if (item.phase === 'ready') await this.remote.install(id, item.revision);
        else throw new Error('WORKSHOP_STATE: 当前阶段不能创建/安装');
        break;
      case 'cancel': await this.remote.cancel(id, item.revision); break;
      case 'undo': await this.remote.revoke(id, item.revision); break;
      case 'restore': await this.remote.restore(id, item.revision); break;
    }
    return { item: await this.get(id) };
  }
}
