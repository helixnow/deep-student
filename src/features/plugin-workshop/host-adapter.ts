import { primaryPlace, type WorkshopAction, type WorkshopActionResult, type WorkshopAdapter, type WorkshopInstalled, type WorkshopItem, type WorkshopPhase, type WorkshopPlace, type WorkshopProgress, type WorkshopSetting } from './types';

/** Poll interval while a work is being made (progress feels live) and otherwise. */
export const WORKSHOP_POLL_ACTIVE_MS = 600;
export const WORKSHOP_POLL_IDLE_MS = 2000;
/** An Agent edit (write_source without validate) older than this no longer holds the card in 「AI 正在改」. */
const AGENT_EDIT_STALE_MS = 15 * 60_000;

/** P3 workshop.md v1 wire contract. Kept separate from display state. */
export interface WorkshopCard {
  kind: 'dstu-plugin-workshop'; id: string; pluginId: string; sessionId: string;
  title: string; description: string; template: 'learning-tool' | 'host-tool';
  state: 'draft' | 'generating' | 'cancelled' | 'pending-confirmation' | 'installed' | 'failed' | 'revoked' | 'superseded';
  revision: number; version: string | null; capabilities: string[]; changes: string[];
  /** Capability lines the Host derived from the validated candidate (agent tools, network hosts, services). */
  declared?: string[];
  trust: 'full'; source: 'workshop'; risk: string;
  check: { ok: boolean; manifest: 'passed' | 'failed'; compile: 'passed' | 'failed'; lifecycle: 'passed' | 'failed' | 'not-run'; visual: 'not-verified'; errors: string[] } | null;
  error: string | null; previousVersion: string | null; createdAt: string; updatedAt: string;
  rollback?: 'not-needed' | 'restored' | 'failed';
  buildAttempt?: number;
  buildStage?: 'making' | 'checking' | null;
  buildFiles?: string[] | null;
  buildStep?: 'link' | 'compile' | 'load' | null;
  settings?: WorkshopSetting[];
  generationApproved?: boolean;
  agentEditing?: string | null;
  places?: WorkshopPlace[];
  /** Where it will probably be (recipe rules), before anything is built. */
  expectedPlaces?: WorkshopPlace[];
  /** The installed version, separate from the proposal in progress (absent on records older than the split). */
  installation?: WorkshopInstallation | null;
  /** The record revision at which the current proposal was made. */
  proposalRevision?: number;
  usableVersion?: string | null;
  lastGoodPackageDir?: string | null;
  lastFault?: string | null;
}
export interface WorkshopInstallation { state: 'installed' | 'failed' | 'revoked'; version: string; previousVersion?: string | null }

/** Must be supplied by the real paired dstu.plugin-workshop UI context. */
export interface WorkshopRemote {
  reportFault?(id: string, error: string): Promise<WorkshopCard>;
  bindSession(id: string, revision: number, sessionId: string): Promise<WorkshopCard>;
  list(): Promise<WorkshopCard[]>;
  status(id: string): Promise<WorkshopCard>;
  create(id: string, revision: number, settings?: Record<string, string>): Promise<WorkshopCard>;
  cancel(id: string, revision: number): Promise<WorkshopCard>;
  install(id: string, revision: number): Promise<WorkshopCard>;
  revoke(id: string, revision: number): Promise<WorkshopCard>;
  restore(id: string, revision: number): Promise<WorkshopCard>;
  export(id: string): Promise<{ id: string; version: string; path: string; fileName?: string }>;
  /** Delete a never-installed work and its sources. */
  discard?(id: string, revision: number): Promise<unknown>;
  /** 「按新版重做」: a modification proposal with the original description. */
  redo?(id: string, revision: number): Promise<WorkshopCard>;
}

export interface WorkshopManagerPort {
  list(): Promise<{ plugins: readonly { id: string; enabled: boolean; state?: string; reason?: string }[] }>;
  setEnabled(id: string, enabled: boolean): Promise<{ ok: true } | { ok: false; code: string; detail?: string }>;
}

const phases: Record<WorkshopCard['state'], WorkshopPhase> = {
  draft: 'proposed', generating: 'generating', cancelled: 'cancelled',
  'pending-confirmation': 'ready', installed: 'installed', failed: 'failed', revoked: 'undone', superseded: 'superseded',
};
/** Proposal phases that still need the user or are being made. */
const OPEN_PHASES: readonly WorkshopPhase[] = ['proposed', 'ready', 'generating', 'editing', 'validating', 'installing'];

/**
 * The installed version as the Host acts on it (same rules as host/plugins/plugin-workshop/src/store.ts
 * `installationOf`): an install or uninstall as the latest step wins, then the recorded installation, then what an
 * older record implies (the last version seen running).
 */
export function workshopInstallation(card: WorkshopCard): WorkshopInstallation | null {
  const recorded = card.installation ?? null;
  if (card.state === 'installed') {
    const version = card.version ?? recorded?.version ?? '';
    return { previousVersion: recorded?.version !== version ? recorded?.version ?? null : recorded?.previousVersion ?? null,
      ...(recorded?.version === version ? recorded : {}), state: 'installed', version };
  }
  if (card.state === 'revoked') {
    const version = recorded?.version ?? card.usableVersion ?? card.version;
    return version ? { ...recorded, state: 'revoked', version } : null;
  }
  if (card.installation !== undefined) return recorded;
  const version = card.usableVersion ?? (card.lastGoodPackageDir ? card.version : null);
  if (!version) return null;
  const isolated = card.state === 'failed' && Boolean(card.lastFault) && card.error?.startsWith(card.lastFault!) === true;
  return { state: isolated ? 'failed' : 'installed', version, previousVersion: null };
}

/** Host-derived facts first, then the Agent's own wording; a line both wrote is shown once. */
export function workshopCapabilities(card: Pick<WorkshopCard, 'capabilities' | 'declared'>): string[] {
  return [...new Set([...(card.declared ?? []), ...card.capabilities].map(line => line.trim()).filter(Boolean))];
}

/** Progress in the user's words: building → checking itself → found a problem, fixing (try n). */
export function workshopProgress(card: Pick<WorkshopCard, 'state' | 'buildAttempt' | 'buildStage' | 'buildFiles' | 'buildStep' | 'error'>): WorkshopProgress | undefined {
  if (card.state !== 'generating') return undefined;
  const finished = card.buildAttempt ?? 0;
  const files = card.buildFiles?.length ? { files: [...card.buildFiles] } : {};
  // An attempt finished with problems and the next one is under way: that is a repair, numbered from the second try.
  if (finished > 0 && card.error && card.buildStage !== 'checking') return { stage: 'fixing', attempt: finished + 1, ...files };
  if (card.buildStage === 'checking') return { stage: 'checking', ...(card.buildStep ? { step: card.buildStep } : {}) };
  return { stage: 'making', ...files };
}

/** The Agent is editing a started work's source itself (honest card state instead of a stale decision). */
function agentEditing(card: Pick<WorkshopCard, 'state' | 'agentEditing'>, now = Date.now()): boolean {
  if (!card.agentEditing || !['draft', 'failed', 'cancelled'].includes(card.state)) return false;
  const since = Date.parse(card.agentEditing);
  return Number.isFinite(since) && now - since < AGENT_EDIT_STALE_MS;
}

/**
 * Where to find the work: what the Host detected in the built candidate; before a build, what the recipe rules expect
 * (marked 预计, see `placesExpected`). Old built cards carry neither: a learning tool is a desktop app, the only safe
 * guess. An unbuilt card without an expectation shows no line rather than a wrong one.
 */
function placesOf(card: WorkshopCard): { places?: WorkshopPlace[]; expected?: boolean } {
  if (card.places) return { places: card.places };
  if (card.expectedPlaces) return card.expectedPlaces.length ? { places: card.expectedPlaces, expected: true } : {};
  return card.template === 'learning-tool' && card.version ? { places: [{ kind: 'app', title: card.title }] } : {};
}

/**
 * `present` is whether the plugin manager lists the plugin. An installed work the manager no longer lists was
 * removed (for example uninstalled elsewhere): it is 已卸载, so the card never offers 打开 for something gone.
 */
export function workshopItem(card: WorkshopCard, enabled?: boolean, degradedReason?: string, present = true): WorkshopItem {
  const installation = workshopInstallation(card);
  const installed: WorkshopInstalled | undefined = installation ? {
    phase: installation.state === 'revoked' ? 'undone' : installation.state === 'failed' ? 'failed'
      : !present ? 'undone' : enabled === false || degradedReason !== undefined ? 'disabled' : 'installed',
    version: installation.version,
    ...(installation.previousVersion && installation.previousVersion !== installation.version ? { previousVersion: installation.previousVersion } : {}),
  } : undefined;
  // The proposal's own step; none while the latest step is an install / uninstall, or when the installed version is
  // what failed (a fault, not a proposal).
  const installationFault = card.state === 'failed' && installation?.state === 'failed';
  const proposalPhase: WorkshopPhase | undefined = card.state === 'installed' || card.state === 'revoked' || installationFault ? undefined
    : agentEditing(card) ? 'editing' : phases[card.state];
  // Lists (manager, creations) show an open or failed proposal; otherwise what is installed.
  const showsProposal = !installed || (proposalPhase !== undefined && (OPEN_PHASES.includes(proposalPhase) || proposalPhase === 'failed'));
  const phase: WorkshopPhase = showsProposal ? proposalPhase ?? installed?.phase ?? phases[card.state] : installed!.phase;
  const { places, expected } = placesOf(card);
  const atInstalled = !showsProposal && installed;
  return {
    id: card.pluginId, proposalId: card.id, revision: card.revision, name: card.title,
    version: atInstalled ? installed.version : card.version ?? '',
    previousVersion: atInstalled ? installed.previousVersion : card.previousVersion ?? undefined,
    description: card.description, capabilities: workshopCapabilities(card), changes: card.changes, trust: card.trust,
    // Showing the installed version: its own problem (degraded reason, or the fault that turned it off), not an
    // older proposal's error. Showing a proposal: the proposal's error.
    phase, error: atInstalled ? degradedReason ?? (installed.phase === 'failed' ? card.error ?? undefined : undefined) : card.error ?? undefined,
    rollback: card.rollback,
    progress: workshopProgress(card),
    ...(places ? { places } : {}),
    ...(expected && !card.version ? { placesExpected: true } : {}),
    ...(card.settings?.length ? { settings: card.settings.map(setting => ({ ...setting })) } : {}),
    ...(card.sessionId ? { sessionId: card.sessionId } : {}),
    ...(installed ? { installed } : {}),
    ...(proposalPhase ? { proposal: { phase: proposalPhase, ...(card.proposalRevision !== undefined ? { revision: card.proposalRevision } : {}) } } : {}),
    updatedAt: card.updatedAt,
  };
}

/**
 * The item as one chat card shows it. Each card belongs to the proposal it was made for (`viewRevision`, the record
 * revision when the AI proposed it). An older card keeps showing the installed version, with a line about the newer
 * proposal; a turned-down or replaced proposal reads so only on its own card, never on the cards before it.
 */
export function workshopCardView(item: WorkshopItem, viewRevision?: number): WorkshopItem {
  const { installed, proposal } = item;
  if (viewRevision === undefined || !installed || !proposal) return item;
  const own = proposal.revision !== undefined && viewRevision >= proposal.revision;
  const exact = proposal.revision !== undefined && viewRevision === proposal.revision;
  if (own && OPEN_PHASES.concat(['failed']).includes(proposal.phase)) return item;
  if (exact && (proposal.phase === 'cancelled' || proposal.phase === 'superseded')) return { ...item, phase: proposal.phase, version: '', previousVersion: undefined };
  const elsewhere = !own && OPEN_PHASES.concat(['failed']).includes(proposal.phase) ? proposal.phase : undefined;
  return { ...item, phase: installed.phase, version: installed.version, previousVersion: installed.previousVersion, progress: undefined,
    error: installed.phase === 'failed' || installed.phase === 'disabled' ? item.error : undefined, ...(elsewhere ? { elsewhere } : {}) };
}

/**
 * `save` offers the system save dialog for an exported file (suggesting its readable name) and resolves to where the
 * user saved it, or null when they cancelled. When it fails the export stays at the Host path, which the card shows
 * with 「在文件夹中显示」 (`reveal`).
 */
export interface WorkshopFilesPort {
  save(path: string, fileName: string): Promise<string | null>;
  reveal?(path: string): Promise<void>;
}

export class HostWorkshopAdapter implements WorkshopAdapter {
  constructor(
    private readonly remote: WorkshopRemote,
    private readonly manager: WorkshopManagerPort,
    /** Open or try an installed work by what it adds: the app, the notes toolbar, or a phrase for the AI assistant. */
    private readonly onOpenPlugin?: (pluginId: string, place?: WorkshopPlace) => void | Promise<void>,
    /** A generation this adapter started finished (ready to install, or failed), even if no card is on screen. */
    private readonly onFinished?: (item: WorkshopItem) => void,
    /** The app's file service: a save dialog for 导出 and 「在文件夹中显示」. */
    private readonly files?: WorkshopFilesPort,
  ) {}

  /** 「在文件夹中显示」 for an exported file; absent when the app cannot reveal files here. */
  get reveal(): ((path: string) => Promise<void>) | undefined {
    const reveal = this.files?.reveal;
    return reveal ? (path: string) => reveal(path) : undefined;
  }

  /** True while the last read saw a work being made: the shared poll runs faster then. */
  private active = false;
  private readonly watching = new Set<string>();
  /** One poll for every card and list on screen (dispatching by id is each subscriber's own lookup in list()). */
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Concurrent list() calls (every subscriber refreshing on the same tick) share one Host read. */
  private inflight: Promise<WorkshopItem[]> | undefined;

  private item(card: WorkshopCard, inventory: Awaited<ReturnType<WorkshopManagerPort['list']>>): WorkshopItem {
    const plugin = inventory.plugins.find(entry => entry.id === card.pluginId);
    return workshopItem(card, plugin?.enabled, plugin?.state === 'degraded' ? plugin.reason : undefined, plugin !== undefined);
  }

  list(): Promise<WorkshopItem[]> {
    if (this.inflight) return this.inflight;
    const read = (async () => {
      const [cards, inventory] = await Promise.all([this.remote.list(), this.manager.list()]);
      this.active = cards.some(card => card.state === 'generating');
      return cards.map(card => this.item(card, inventory));
    })();
    this.inflight = read;
    const clear = () => { if (this.inflight === read) this.inflight = undefined; };
    read.then(clear, clear);
    return read;
  }

  async get(id: string): Promise<WorkshopItem> {
    const [card, inventory] = await Promise.all([this.remote.status(id), this.manager.list()]);
    return this.item(card, inventory);
  }

  subscribe(listener: () => void): () => void {
    // P3 exposes authoritative status reads, not a progress event: one shared poll for all subscribers, fast only
    // while a work is being made. Each tick notifies every subscriber; their list() calls share one Host read.
    this.listeners.add(listener);
    if (this.timer === undefined) this.schedule();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size && this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
    };
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.listeners.size) return;
      for (const listener of [...this.listeners]) listener();
      this.schedule();
    }, this.active ? WORKSHOP_POLL_ACTIVE_MS : WORKSHOP_POLL_IDLE_MS);
  }

  /** Follow a started generation to its end in the background and report it once (see onFinished). */
  private watch(id: string): void {
    if (!this.onFinished || this.watching.has(id)) return;
    this.watching.add(id);
    const poll = async (): Promise<void> => {
      try {
        const item = await this.get(id);
        if (item.phase === 'generating') { setTimeout(() => { void poll(); }, 1500); return; }
        this.watching.delete(id);
        if (item.phase === 'ready' || item.phase === 'failed') this.onFinished?.(item);
      } catch { this.watching.delete(id); }
    };
    setTimeout(() => { void poll(); }, 1500);
  }

  async act(action: WorkshopAction, item: WorkshopItem, input?: Record<string, string>): Promise<WorkshopActionResult> {
    const id = item.proposalId;
    if (action === 'export') {
      const exported = await this.remote.export(id);
      const exportName = exported.fileName ?? exported.path.split(/[\\/]/).pop() ?? 'plugin.dstuplugin';
      let exportPath = exported.path;
      if (this.files) {
        try {
          const saved = await this.files.save(exported.path, exportName);
          if (saved === null) return { item: await this.get(id), exportName };
          exportPath = saved;
        } catch (error) {
          // No dialog here (or it failed): the file stays where the Host wrote it, under its readable name.
          console.warn('[plugin-workshop] save dialog unavailable; keeping the exported file in place', error);
        }
      }
      return { item: await this.get(id), exportPath, exportName };
    }
    if (action === 'try' || action === 'disable') {
      // Trying a running work only opens it; an off one is turned on first.
      if (action === 'disable' || item.phase !== 'installed') {
        let result = await this.manager.setEnabled(item.id, action === 'try');
        // The profile revision is a CAS token the manager port caches from its last read; the manager panel (or the
        // Host finishing a toggle: it stops the plugin before writing the profile) may have written since. Turning one
        // plugin on/off is idempotent and touches only its own entry, so after the port's refresh it is sent once more
        // instead of failing the user's click with 「出了点问题」.
        if (result.ok === false && result.code === 'PROFILE_CONFLICT') result = await this.manager.setEnabled(item.id, action === 'try');
        if (result.ok === false) throw new Error(result.detail ?? result.code);
      }
      const updated = await this.get(id);
      if (action === 'try') await this.onOpenPlugin?.(item.id, primaryPlace(updated) ?? primaryPlace(item));
      return { item: updated };
    }
    if (item.revision === undefined) throw new Error('WORKSHOP_CONFLICT: card has no revision; refresh it');
    // Do not read a fresh revision here: consent belongs to the candidate displayed to the user.
    switch (action) {
      case 'confirm':
        if (item.phase === 'proposed' || item.phase === 'failed') {
          // 开始做 (or 再试一次 after a setting could not be used): the user's approval to generate and test-load.
          await (input ? this.remote.create(id, item.revision, { ...input }) : this.remote.create(id, item.revision));
          this.watch(id);
        } else if (item.phase === 'ready') await this.remote.install(id, item.revision);
        else throw new Error(`WORKSHOP_STATE: cannot confirm in ${item.phase}`);
        break;
      case 'cancel': await this.remote.cancel(id, item.revision); break;
      case 'discard':
        if (!this.remote.discard) throw new Error('WORKSHOP_UNAVAILABLE: this Host cannot delete works');
        await this.remote.discard(id, item.revision);
        return { removed: true };
      case 'redo':
        if (!this.remote.redo) throw new Error('WORKSHOP_UNAVAILABLE: this Host cannot redo works');
        await this.remote.redo(id, item.revision);
        break;
      case 'undo': await this.remote.revoke(id, item.revision); break;
      case 'restore': await this.remote.restore(id, item.revision); break;
    }
    return { item: await this.get(id) };
  }
}
