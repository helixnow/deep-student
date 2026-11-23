// RUST-FIX(RF-P3-workshop-tools): user-owned generation, cancellation and retained-version recovery.
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { CommandError, type AppInfo, type PluginManagerConfigView, type PluginManagerInventory, type PluginManagerInstallResult } from '../../../kernel/api.ts';
import { isValidPluginId } from '../../../kernel/plugin-id.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import type { PluginWorkshopService, WorkshopBrief, WorkshopCard, WorkshopCheck, WorkshopExport, WorkshopInstallation, WorkshopDelegationOptions, WorkshopStoredData, WorkshopValidationOutcome, WorkshopVerificationResult } from '../api.ts';
import { OPEN_PROPOSAL_STATES, WorkshopStore, installationOf, withBoundSession } from './store.ts';
import { compileWorkshop, checkWorkshopLifecycle, sourceFiles, type WorkshopBuild } from './compiler.ts';
import { parseDegradedReason } from '../../../kernel/plugin-load-error.ts';
import { writeHostStderr } from '../../../kernel/kernel.ts';
import { isManagedChild } from './paths.ts';
import { writeSourceFiles, type SourceFile } from './source.ts';
import type { WorkshopActivationResult, WorkshopSelfCheckContext } from '../../../kernel/plugin-admin.ts';
import { checkSettingLinks, fillSettings, normalizeWorkshopSource, versionGreater, settingValues, storeSecretSettings, type WorkshopLinkReader, type WorkshopSecretStore } from './settings.ts';
import { exportPackageExtension } from './study-pack.ts';

// Compatibility failures belong to the running app version. Keep the
// installed revision enabled on disk so another app version can load it.
function isCompatibilityFailure(reason: string | undefined): boolean {
  const code = reason === undefined ? undefined : parseDegradedReason(reason).code;
  return code === 'ENGINE_INCOMPATIBLE' || code === 'MANIFEST_VERSION_UNSUPPORTED'
    || code === 'REQUIRES_INCOMPATIBLE' || code === 'REQUIRES_MISSING'
    || code === 'UNSUPPORTED_ON_PLATFORM';
}

/**
 * Problems of the environment, not of the generated code: another repair round cannot fix them, so generation stops
 * at once and the card says what to do (restart normally, turn the needed app feature back on, …).
 */
export function isEnvironmentError(text: string | null | undefined): boolean {
  return /SAFE_MODE_ACTIVE|WORKSHOP_SELF_CHECK_UNAVAILABLE|WORKSHOP_GENERATION_UNAVAILABLE|WORKSHOP_INSTALL_UNAVAILABLE|WORKSHOP_UNAVAILABLE/.test(text ?? '');
}
/** `<标题>-v<version>.dstuplugin` (or `.dspack` for study packs): a file name a learner recognises, safe on every file system. */
export function exportFileName(title: string, version: string, kind?: 'plugin' | 'study-pack'): string {
  const safe = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 60).trim() || 'plugin';
  return `${safe}-v${version}${exportPackageExtension(kind)}`;
}
const isOpenProposal = (state: WorkshopCard['state']) => OPEN_PROPOSAL_STATES.includes(state);

export interface WorkshopAdmin {
  inventory(): Promise<PluginManagerInventory>;
  installManagedDirectory(request: { id: string; directory: string; revision: string; version: string; permissions: readonly string[]; confirmed: true }): Promise<PluginManagerInstallResult>;
  uninstall(id: string, revision: string): Promise<unknown>;
  /** Optional so test drivers that only exercise installation keep working. */
  configOf?(id: string): Promise<PluginManagerConfigView>;
  /** Optional so test drivers that only exercise installation keep working. */
  configureManaged?(id: string, values: Record<string, unknown>): Promise<PluginManagerConfigView>;
  /** Optional so test drivers that only exercise installation keep working. */
  setEnabledManaged?(id: string, enabled: boolean): Promise<unknown>;
  onActivation?(listener: (result: WorkshopActivationResult) => Promise<void>): () => void;
  selfCheckContext?(id: string, names: readonly string[]): Promise<WorkshopSelfCheckContext>;
  activateManaged?(id: string, revision: string): Promise<unknown>;
  isolateManaged?(id: string): Promise<unknown>;
  onFault?(listener: (id: string, reason: string) => Promise<void>): () => void;
}
export interface WorkshopGeneration {
  /**
   * `progress` receives the source files the model has written so far in this attempt (best effort). May report the
   * tokens the attempt used (from the generation conversation's message usage) for the card's 「用了多少」 line.
   */
  generate(card: WorkshopCard, source: string, signal: AbortSignal, progress?: (files: string[]) => void): Promise<void | { tokens?: number; blockedReason?: string }>;
  /** Runs actual application tools against the activated candidate; evidence is required for success. */
  verify?(card: WorkshopCard, source: string, signal: AbortSignal): Promise<WorkshopVerificationResult>;
}
export class WorkshopOperations implements Omit<PluginWorkshopService, 'developmentSkill'> {
  readonly store: WorkshopStore;
  readonly app: AppInfo;
  private admin: WorkshopAdmin | null = null;
  private restart: (() => Promise<unknown>) | null = null;
  private generation: WorkshopGeneration | null = null;
  private candidatePreview: ((candidate: { id: string; pluginId: string; version: string; revision: number }) => void | Promise<void>) | null = null;
  private linkReader: WorkshopLinkReader | null = null;
  private readonly jobs = new Map<string, AbortController>();
  private readonly candidates = new Map<string, WorkshopBuild>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private disposed = false;
  private unobserve: (() => void) | null = null;
  private unobserveFaults: (() => void) | null = null;
  constructor(app: AppInfo) { this.app = app; this.store = new WorkshopStore(app.dataDir); }
  bindAdmin(admin: WorkshopAdmin): void {
    this.unobserve?.(); this.admin = admin;
    this.unobserve = admin.onActivation?.(result => this.activationResult(result)) ?? null;
    this.unobserveFaults?.();
    this.unobserveFaults = admin.onFault?.(async (id, reason) => {
      const card = (await this.store.list()).find(item => item.pluginId === id && installationOf(item)?.state === 'installed');
      if (card && !isCompatibilityFailure(reason)) await this.reportFault(card.id, reason);
    }) ?? null;
  }
  private async activationResult(result: WorkshopActivationResult): Promise<void> {
    const work = (await this.store.list()).find(card => card.pluginId === result.id);
    if (!work) return;
    await this.serial(work.id, async () => {
      const card = await this.store.read(work.id);
      if (card.pendingRestore || card.version !== result.attemptedVersion) return;
      const installed = installationOf(card);
      if (result.success) {
        // Activation is not behavior verification. Only the verifier may advance the usable pointer.
        const recovered = card.state === 'failed' && installed?.state === 'failed';
        if (result.actualVersion && recovered) await this.store.update(card.id, card.revision, {
          state: 'installed', error: null,
          installation: { previousVersion: null, ...installed, state: 'installed', version: result.actualVersion },
        });
        return;
      }
      // The kernel put the retained version back: that one is installed; otherwise the attempted one is off.
      const retained = result.rollback === 'restored' && card.usableVersion && card.usableVersion !== result.attemptedVersion ? card.usableVersion : null;
      const installation: WorkshopInstallation | null = retained ? { previousVersion: null, ...installed, state: 'installed', version: retained }
        : installed ? { ...installed, state: 'failed' } : null;
      await this.store.update(card.id, card.revision, { state: 'failed', error: result.error, installation, ...(result.rollback ? { rollback: result.rollback } : {}) });
    });
  }
  bindGeneration(generation: WorkshopGeneration): void { this.generation = generation; }
  bindCandidatePreview(preview: NonNullable<WorkshopOperations['candidatePreview']>): void { this.candidatePreview = preview; }
  /** HTTPS reader for the calendar-address check (WorkshopSetting `ics-url`). */
  bindLinkReader(reader: WorkshopLinkReader): void { this.linkReader = reader; }
  private secretStore: WorkshopSecretStore | null = null;
  /** Where card secrets go (the settings service's secure store, under the plugin's pluginSecrets key). */
  bindSecretStore(store: WorkshopSecretStore): void { this.secretStore = store; }
  private settingsReader: (() => Pick<SettingsStore, 'listByPrefix' | 'deleteByPrefix'> | undefined) | null = null;
  /** Optional settings store reader for listing/clearing `${pluginId}.*` entries. */
  bindSettings(reader: () => Pick<SettingsStore, 'listByPrefix' | 'deleteByPrefix'> | undefined): void { this.settingsReader = reader; }
  /** Host process lifecycle stays with the app shell; plugin/config changes never need it. */
  bindRestart(restart: () => Promise<unknown>): void { this.restart = restart; }
  /** Read-only plugin inventory as the plugin manager shows it (state, trust, hasConfig). */
  inventory(): Promise<PluginManagerInventory> { return this.manager().inventory(); }
  /** Read any plugin's config schema and current values; never writes. */
  configGet(pluginId: string): Promise<PluginManagerConfigView> {
    const admin = this.manager();
    if (!admin.configOf) throw new Error('WORKSHOP_UNAVAILABLE: plugin configuration is not available from this Host');
    return admin.configOf(pluginId);
  }
  /** Hot-update a running plugin's config; persistence is revision-checked by the kernel. */
  configure(pluginId: string, values: Record<string, unknown>): Promise<PluginManagerConfigView> {
    const admin = this.manager();
    if (!admin.configureManaged) throw new Error('WORKSHOP_UNAVAILABLE: plugin configuration is not available from this Host');
    return admin.configureManaged(pluginId, values);
  }
  /** Hot-load or unload a managed plugin; never edits code or profiles directly. */
  setEnabled(pluginId: string, enabled: boolean): Promise<unknown> {
    const admin = this.manager();
    if (!admin.setEnabledManaged) throw new Error('WORKSHOP_UNAVAILABLE: plugin enablement is not available from this Host');
    return admin.setEnabledManaged(pluginId, enabled);
  }
  /** App restart is requested only when the user explicitly asked for one. */
  async requestRestart(): Promise<{ restartRequested: boolean; note: string }> {
    const restart = this.restart;
    if (!restart) throw new Error('WORKSHOP_UNAVAILABLE: app restart is not available from this Host');
    await restart();
    return { restartRequested: true,
      note: 'Plugins and config changes hot-load automatically without restart; app restart triggered as requested.' };
  }
  private manager(): WorkshopAdmin {
    const admin = this.admin;
    if (!admin) throw new Error('WORKSHOP_UNAVAILABLE: kernel plugin manager is not bound');
    return admin;
  }
  private async assertExecutionAllowed(): Promise<void> {
    if (this.admin && (await this.admin.inventory()).safeMode) throw new Error('SAFE_MODE_ACTIVE: workshop code cannot run or install in safe mode');
  }
  private checkLifecycle(built: WorkshopBuild): Promise<WorkshopCheck> {
    const owner = this.admin;
    return checkWorkshopLifecycle(built, this.app, owner?.selfCheckContext && built.manifest
      ? names => owner.selfCheckContext!(built.manifest!.id, names) : undefined);
  }
  async ready(): Promise<void> {
    await this.store.recoverInterrupted();
    if (!this.admin) return;
    const inventory = await this.admin.inventory();
    if (inventory.safeMode) return;
    for (const card of await this.store.list()) {
      const installed = inventory.plugins.find(entry => entry.id === card.pluginId);
      const installation = installationOf(card);
      if (card.pendingRestore) {
        try { await this.restoreVersion(card.id, card.revision, card.pendingRestore.repair); }
        catch (error) { writeHostStderr(`[plugin-workshop] could not finish rollback of ${card.id}: ${String(error)}\n`); }
      } else if (card.state === 'cancelled' && card.validation?.status === 'pending' && installation?.version === card.validation.version) {
        await this.reportFault(card.id, 'WORKSHOP_CANCELLED: candidate verification cancelled', card.validation.version);
        const current = await this.status(card.id);
        await this.store.update(card.id, current.revision, { state: 'cancelled', execution: null });
      } else if ((card.execution?.stage === 'installing' || card.state === 'pending-confirmation' && card.validation?.status === 'pending')
        && installed?.state === 'running' && installed.version
        && installed.version === card.validation?.version) {
        await this.store.update(card.id, card.revision, { state: 'installed', version: installed.version,
          installation: { state: 'installed', version: installed.version, previousVersion: card.usableVersion ?? null },
          ...(card.execution ? { execution: { ...card.execution, stage: 'validating' } } : {}) });
      } else if (installed?.state === 'degraded' && installation?.state === 'installed' && !isCompatibilityFailure(installed.reason)) {
        await this.reportFault(card.id, installed.reason ?? 'Plugin activation failed');
      } else if (card.state === 'installed' && installed?.source === 'workshop' && installed.state === 'running' && installed.version
        && installed.version !== card.version && [installation?.previousVersion, card.previousVersion, card.usableVersion].includes(installed.version)) {
        // Older builds could switch the package without recording the rollback. Adopt the known running release.
        await this.recordRestore(card, { version: installed.version, previousVersion: null, repair: card.execution?.stage === 'repairing' });
      } else if (card.state === 'installed' && card.rollback === 'restored' && card.validation?.status !== 'pending'
        && (card.execution?.stage === 'validating' || card.execution?.stage === 'blocked')) {
        // Older successful rollbacks could leave the superseded candidate's task attached on disk.
        await this.store.update(card.id, card.revision, { execution: null, error: null });
      }
    }
  }
  dispose(): void { this.disposed = true; this.unobserve?.(); this.unobserveFaults?.(); for (const controller of this.jobs.values()) controller.abort(); }
  private serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    this.locks.set(id, next);
    void next.then(() => { if (this.locks.get(id) === next) this.locks.delete(id); },
      () => { if (this.locks.get(id) === next) this.locks.delete(id); });
    return next;
  }
  /**
   * A new proposal of a conversation replaces that conversation's older proposals nobody started yet (the AI changed
   * the plan): they become `superseded` and drop out of the lists. Started, installed or other conversations' works
   * are untouched.
   */
  async propose(brief: WorkshopBrief): Promise<WorkshopCard> {
    const existing = brief.pluginId ? (await this.store.list()).find(item => item.pluginId === brief.pluginId) : undefined;
    const card = existing ? await this.serial(existing.id, async () => {
      if (this.jobs.has(existing.id)) throw new Error('WORKSHOP_STATE: existing work is busy');
      return this.store.propose(brief);
    }) : await this.store.propose(brief);
    for (const other of await this.store.list()) {
      if (other.id === card.id || other.state !== 'draft' || other.sessionId !== card.sessionId) continue;
      await this.serial(other.id, async () => {
        const fresh = await this.store.read(other.id);
        if (fresh.state === 'draft' && fresh.sessionId === card.sessionId) await this.store.update(fresh.id, fresh.revision, { state: 'superseded', agentEditing: null });
      }).catch(error => writeHostStderr(`[plugin-workshop] could not supersede ${other.id}: ${String(error)}\n`));
    }
    return card;
  }
  /** 「按新版重做」: propose the work again with its original description, in its current conversation. */
  redo(id: string, revision: number): Promise<WorkshopCard> {
    return this.serial(id, async () => {
      const card = await this.store.read(id);
      if (card.revision !== revision) throw new Error('WORKSHOP_CONFLICT: confirmation is stale');
      if (isOpenProposal(card.state)) throw new Error(`WORKSHOP_STATE: cannot act in ${card.state}`);
      return this.store.propose({ sessionId: card.sessionId, title: card.title, description: card.description, template: card.template,
        pluginId: card.pluginId, changes: ['按当前应用版本重新做一遍，功能保持不变'], capabilities: [...card.capabilities],
        ...(card.settings?.length ? { settings: card.settings } : {}) });
    });
  }
  /**
   * 「把需求砍成最小版再试」 after repeated failures: a new proposal of the same work that keeps only its core (the first
   * acceptance item), with the generation told to leave everything else out. The user presses 开始做 again.
   */
  reduce(id: string, revision: number): Promise<WorkshopCard> {
    return this.serial(id, async () => {
      const card = await this.store.read(id);
      if (card.revision !== revision) throw new Error('WORKSHOP_CONFLICT: confirmation is stale');
      if (isOpenProposal(card.state) && card.state !== 'draft') throw new Error(`WORKSHOP_STATE: cannot act in ${card.state}`);
      const core = card.changes.find(item => item.trim()) ?? card.description;
      return this.store.propose({ sessionId: card.sessionId, title: card.title,
        description: `最小版：只做最核心的一件事——${core.replace(/^最小版：只做最核心的一件事——/, '')}。其余功能先不做，界面和代码尽量简单（少于 3 个文件）。`,
        template: card.template, pluginId: card.pluginId,
        changes: [core, '只保留这一项，其余功能以后再加'], capabilities: [...card.capabilities],
        ...(card.settings?.length ? { settings: card.settings } : {}) });
    });
  }
  /**
   * Delete a work that was never installed, with its sources and builds (「删除」 on a failed or abandoned work).
   * Anything that was installed at some point keeps its retained versions: it is removed with 卸载 instead.
   */
  discard(id: string, revision: number): Promise<{ id: string; discarded: true }> {
    return this.serial(id, async () => {
      const card = await this.store.read(id);
      if (card.revision !== revision) throw new Error('WORKSHOP_CONFLICT: confirmation is stale');
      if (installationOf(card) || card.usableVersion || card.lastGoodPackageDir) throw new Error('WORKSHOP_STATE: installed works are removed with 卸载; their versions are kept');
      if (card.state === 'generating') throw new Error('WORKSHOP_STATE: cannot act in generating');
      this.jobs.get(id)?.abort();
      this.candidates.delete(id);
      await rename(this.store.directory(id), join(tmpdir(), `dstu-workshop-discarded-${id}-${randomUUID()}`));
      return { id, discarded: true as const };
    });
  }
  bindSession(id: string, revision: number, sessionId: string): Promise<WorkshopCard> {
    return this.serial(id, async () => {
      if (!sessionId.trim()) throw new Error('WORKSHOP_INVALID: editing session is required');
      await this.expected(id, revision, ['draft', 'installed', 'revoked', 'failed', 'cancelled', 'superseded']);
      const card = await this.store.read(id);
      // Earlier conversations stay bound: the user can keep going in the original chat after a modification.
      return this.store.update(id, revision, { sessionId, boundSessions: withBoundSession(card, sessionId) });
    });
  }
  list(): Promise<WorkshopCard[]> { return this.store.list(); }
  status(id: string): Promise<WorkshopCard> { return this.store.read(id); }
  private async expected(id: string, revision: number, states: WorkshopCard['state'][]): Promise<WorkshopCard> {
    const card = await this.store.read(id);
    if (card.revision !== revision) throw new Error('WORKSHOP_CONFLICT: confirmation is stale');
    if (!states.includes(card.state)) throw new Error(`WORKSHOP_STATE: cannot act in ${card.state}`);
    return card;
  }
  /**
   * 开始做: the user's approval to generate this proposal and test-load the result in the Host (the Agent's
   * proposal alone never runs model-written code). `values` fills the settings the card asked for; anything else
   * passed there (e.g. the remote call context) is ignored.
   */
  create(id: string, revision: number, values?: unknown): Promise<WorkshopCard> {
    return this.startGeneration(id, revision, values);
  }
  delegate(id: string, revision: number, options: WorkshopDelegationOptions = {}): Promise<WorkshopCard> {
    return this.startGeneration(id, revision, options.settings, options);
  }
  private startGeneration(id: string, revision: number, values?: unknown, delegation?: WorkshopDelegationOptions,
    resume = false): Promise<WorkshopCard> {
    return this.serial(id, async () => {
      await this.assertExecutionAllowed();
      if (this.disposed) throw new Error('WORKSHOP_UNAVAILABLE: Host is shutting down');
      const present = await this.status(id);
      if (present.revision !== revision) throw new Error('WORKSHOP_CONFLICT: confirmation is stale');
      if (present.pendingRestore) throw new Error('WORKSHOP_STATE: finish the pending rollback first');
      if (!resume && present.state === 'installed' && present.execution?.stage === 'blocked'
        && present.validation?.status === 'pending' && installationOf(present)?.version === present.validation.version) {
        // Keep the installed candidate, but give the new verifier its own attempt identity.
        if (!this.generation?.verify) throw new Error('WORKSHOP_VERIFICATION_UNAVAILABLE: runtime verification is not available');
        const settings = present.settings?.length ? await storeSecretSettings(present.pluginId, fillSettings(present.settings, values), this.secretStore) : present.settings;
        const changed = JSON.stringify(settings) !== JSON.stringify(present.settings);
        if (changed) {
          const config = settingValues(settings);
          if (config) await this.configure(present.pluginId, config);
        }
        this.jobs.get(id)?.abort(); this.jobs.delete(id);
        const retry = await this.store.update(id, revision, { error: null, ...(changed ? { settings } : {}),
          validation: { ...present.validation, revision: revision + 1, detail: undefined }, execution: { ...present.execution, stage: 'validating', reason: undefined } });
        this.startVerification(retry);
        return retry;
      }
      const current = await this.expected(id, revision, resume ? ['generating', 'failed', 'installed'] : ['draft', 'cancelled', 'failed']);
      if (this.jobs.has(id)) throw new Error('WORKSHOP_STATE: this work already has an active task');
      const generation = this.generation;
      if (!generation) throw new Error('WORKSHOP_GENERATION_UNAVAILABLE: chat pipeline is not ready');
      const execution = delegation ? { mode: 'delegated' as const, stage: 'generating' as const,
        ...(delegation.modelId ? { modelId: delegation.modelId } : {}) }
        : current.execution?.mode === 'delegated' ? { ...current.execution, stage: 'generating' as const, reason: undefined } : undefined;
      let settings;
      try {
        settings = current.settings?.length ? await storeSecretSettings(current.pluginId, fillSettings(current.settings, values), this.secretStore) : undefined;
      } catch (error) {
        if (!execution) throw error;
        return this.store.update(id, revision, { state: 'failed', generationApproved: true,
          execution: { ...execution, stage: 'blocked', reason: String(error) }, error: String(error) });
      }
      if (!resume && current.state !== 'failed') await this.startFromInstalled(current);
      const card = await this.store.update(id, revision, { state: 'generating', check: null, error: null, generationApproved: true,
        ...(execution ? { execution } : {}), validation: null,
        agentEditing: null, buildAttempt: 0, buildStage: null, buildFiles: null, buildStep: null, ...(settings ? { settings } : {}),
        generation: { startedAt: new Date().toISOString() } });
      const controller = new AbortController();
      this.jobs.set(id, controller);
      // Runtime/compiler diagnostics survive into the new repair generation, even though the progress card clears its error.
      const task = { ...card, ...(current.state === 'failed' || resume ? { error: current.error, check: current.check } : {}) };
      void this.run(task, controller, generation).catch(error => {
        writeHostStderr(`[plugin-workshop] background task ${id} failed to persist: ${String(error)}\n`);
      });
      return card;
    });
  }
  /** Called once after every dependency is bound. Reconcile disk state before resuming the unfinished phase. */
  async resumeDelegated(): Promise<void> {
    for (const card of await this.store.list()) {
      if (this.disposed || this.jobs.has(card.id) || card.pendingRestore) continue;
      if (card.state === 'installed' && card.validation?.status === 'pending' && (!card.execution || card.execution.stage === 'validating')) {
        // A renderer may still have a report in flight from before the Host restarted.
        const resumed = await this.store.update(card.id, card.revision, { validation: { ...card.validation, revision: card.revision + 1 } });
        this.startVerification(resumed);
        continue;
      }
      if (card.execution?.mode !== 'delegated' || ['complete', 'blocked'].includes(card.execution.stage)
        || ['cancelled', 'revoked', 'superseded'].includes(card.state)) continue;
      try {
        if (card.execution.stage === 'repairing' || card.state === 'failed' && ['installing', 'validating'].includes(card.execution.stage)) {
          const repairing = card.execution.stage === 'repairing' ? card : await this.store.update(card.id, card.revision, { execution: { ...card.execution, stage: 'repairing' } });
          await this.recoverAndRepair(repairing, card.error ?? card.lastFault ?? 'Candidate activation was interrupted', card.validation?.version ?? card.version);
        } else if (card.state === 'generating') {
          await this.startGeneration(card.id, card.revision, undefined, undefined, true);
        } else if (card.state === 'pending-confirmation') {
          const controller = new AbortController();
          this.jobs.set(card.id, controller);
          void this.finishDelegated(card, controller).catch(error => this.blockExecution(card.id, String(error), controller))
            .finally(() => { if (this.jobs.get(card.id) === controller) this.jobs.delete(card.id); });
        }
      } catch (error) { await this.blockExecution(card.id, String(error)); }
    }
  }
  private async blockExecution(id: string, reason: string, controller?: AbortController): Promise<WorkshopCard> {
    return this.serial(id, async () => {
      const card = await this.store.read(id);
      if (controller?.signal.aborted || controller && this.jobs.get(id) !== controller
        || ['cancelled', 'revoked'].includes(card.state)) return card;
      return this.store.update(id, card.revision, { error: reason, buildStage: null, buildStep: null, buildFiles: null,
        ...(card.state === 'generating' ? { state: 'failed' } : {}),
        ...(card.execution ? { execution: { ...card.execution, stage: 'blocked', reason } } : {}),
        ...(card.validation?.status === 'pending' ? { validation: { ...card.validation, detail: reason } } : {}) });
    });
  }
  private startVerification(card: WorkshopCard): void {
    if (this.disposed || this.jobs.has(card.id) || !this.generation?.verify) return;
    const controller = new AbortController();
    this.jobs.set(card.id, controller);
    void this.finishDelegated(card, controller).catch(error => this.blockExecution(card.id, String(error), controller))
      .finally(() => { if (this.jobs.get(card.id) === controller) this.jobs.delete(card.id); });
  }
  private async finishDelegated(card: WorkshopCard, controller: AbortController): Promise<void> {
    if (controller.signal.aborted || this.disposed) return;
    let installed: WorkshopCard;
    try { installed = card.state === 'pending-confirmation' ? await this.install(card.id, card.revision) : card; }
    catch (error) {
      if (controller.signal.aborted || this.disposed) return;
      const failed = await this.serial(card.id, async () => {
        const current = await this.status(card.id);
        if (this.jobs.get(card.id) !== controller || current.execution?.mode !== 'delegated') return null;
        controller.abort(); this.jobs.delete(card.id);
        return this.store.update(card.id, current.revision, { state: 'failed', error: String(error),
          execution: { ...current.execution, stage: 'repairing', reason: String(error) } });
      });
      if (failed) await this.recoverAndRepair(failed, String(error), failed.validation?.version ?? failed.version);
      return;
    }
    if (controller.signal.aborted || this.disposed) return;
    const verification = this.generation?.verify;
    if (!verification) { await this.blockExecution(card.id, 'WORKSHOP_VERIFICATION_UNAVAILABLE: runtime verification is not available', controller); return; }
    const validation = installed.validation;
    if (!validation || validation.status !== 'pending') return;
    let result: WorkshopVerificationResult;
    try {
      // Host installation is already committed. The paired UI opens only this exact pending candidate.
      await this.candidatePreview?.({ id: installed.id, pluginId: installed.pluginId, version: validation.version, revision: validation.revision });
      if (controller.signal.aborted || this.disposed) return;
      result = await verification.call(this.generation, installed, join(this.store.directory(card.id), 'source'), controller.signal);
    }
    catch (error) { await this.blockExecution(card.id, String(error), controller); return; }
    if (controller.signal.aborted || this.disposed) return;
    if (result.status === 'blocked') {
      await this.blockExecution(card.id, result.error ?? 'Runtime verification needs information or an unavailable application capability', controller);
      return;
    }
    await this.completeValidation(card.id, validation.version, validation.revision, {
      ok: result.status === 'passed' && result.evidence.length > 0,
      detail: result.error ?? (result.status === 'passed' && !result.evidence.length ? 'Verification returned no actual operation evidence' : undefined),
      evidence: result.evidence,
    }, controller);
  }
  /**
   * Put the source of the version in use back into `source/` before a modification is made. The previous draft is kept
   * under `drafts/<revision>` (never deleted), so nothing the AI wrote is lost, but none of it leaks into this change.
   */
  private async startFromInstalled(card: WorkshopCard): Promise<void> {
    const installed = installationOf(card);
    const version = installed?.state === 'installed' ? installed.version : card.usableVersion;
    if (!version) return;
    const root = this.store.directory(card.id);
    const retained = join(root, 'versions', version, 'source');
    try { if (!(await stat(retained)).isDirectory()) return; } catch { return; }
    const source = join(root, 'source');
    if ((await sourceFiles(source).catch(() => [])).length) {
      const draft = join(root, 'drafts', String(card.revision));
      await mkdir(join(root, 'drafts'), { recursive: true });
      // Preserve earlier attempts if the same record is resumed more than once.
      const target = await stat(draft).then(() => `${draft}-${randomUUID()}`, () => draft);
      await rename(source, target);
    }
    await cp(retained, source, { recursive: true });
  }
  private async normalizeSource(source: string, card: WorkshopCard): Promise<void> {
    // Retained folders include failed activation attempts. Do not reuse their versions or overwrite recovery sources.
    // Keep card.previousVersion as the previous usable release; it is also consumed by recovery and older clients.
    const entries = await readdir(join(this.store.directory(card.id), 'versions'), { withFileTypes: true });
    let previousVersion = card.previousVersion;
    for (const entry of entries) if (entry.isDirectory() && (versionGreater(entry.name, previousVersion ?? '0.0.0')
      || !previousVersion && entry.name === '0.0.0')) previousVersion = entry.name;
    await normalizeWorkshopSource(source, { ...card, previousVersion });
  }
  private async run(card: WorkshopCard, controller: AbortController, generation: WorkshopGeneration): Promise<void> {
    // Time and tokens of this run, written with the final state (the card shows them after it finished).
    const started = Date.now();
    let tokens: number | undefined;
    let attempts = 0;
    const stats = () => ({ generation: { startedAt: card.generation?.startedAt ?? new Date(started).toISOString(), durationMs: Date.now() - started,
      attempts, ...(tokens !== undefined ? { tokens } : {}) } });
    try {
      let built: WorkshopBuild | undefined;
      // A bounded repair conversation: exact compiler/lifecycle errors become the next task.
      let task = card;
      const source = join(this.store.directory(card.id), 'source');
      // The address the user entered must really be a calendar before any code is written for it.
      if (card.settings?.some(setting => setting.kind === 'ics-url')) {
        await this.progressOf(card.id, controller, { buildStage: 'checking', buildStep: 'link' });
        await checkSettingLinks(card.settings, this.linkReader, controller.signal);
        if (controller.signal.aborted) return;
      }
      for (let attempt = 1; card.execution?.mode === 'delegated' || attempt <= 3; attempt++) {
        try {
          await this.progressOf(card.id, controller, { buildStage: 'making', buildStep: null, buildFiles: [] });
          let reported = '';
          attempts = attempt;
          const used = await generation.generate(task, source, controller.signal, files => {
            const key = files.join('|');
            if (key === reported) return;
            reported = key;
            void this.progressOf(card.id, controller, { buildFiles: [...files] });
          });
          if (used && typeof used.tokens === 'number' && used.tokens > 0) tokens = (tokens ?? 0) + used.tokens;
          if (controller.signal.aborted) return;
          if (used?.blockedReason) { await this.blockExecution(card.id, used.blockedReason, controller); return; }
          // Host bookkeeping (a version above the retained one, net:<host> of the user's address) is not a repair round.
          await this.normalizeSource(source, card);
          await this.progressOf(card.id, controller, { buildStage: 'checking', buildStep: 'compile' });
          built = await this.build(card.id, controller.signal, () => this.progressOf(card.id, controller, { buildStep: 'load' }));
          task = { ...task, check: built.check, error: built.check.errors.join('\n') };
        } catch (error) {
          task = { ...task, error: error instanceof Error ? error.message : String(error) };
          built = undefined;
        }
        await this.progressOf(card.id, controller, { buildAttempt: attempt, check: task.check, error: task.error });
        if (controller.signal.aborted) return;
        if (built?.check.ok) break;
        // Preserve legacy manual behavior; delegated tasks use the generator's explicit blockedReason contract.
        if (card.execution?.mode !== 'delegated' && isEnvironmentError(task.error)) break;
      }
      if (!built) throw new Error(task.error ?? 'WORKSHOP_INVALID: generation failed');
      if (built.check.ok) {
        const snapshot = `${built.directory}-source`;
        await cp(built.sourceDirectory, snapshot, { recursive: true });
        built.sourceDirectory = snapshot;
        await writeFile(join(this.store.directory(card.id), 'candidate.json'), JSON.stringify(built));
      }
      await this.serial(card.id, async () => {
        if (controller.signal.aborted) return;
        const current = await this.status(card.id);
        await this.store.update(card.id, current.revision, { state: built.check.ok ? 'pending-confirmation' : 'failed',
          check: built.check, version: built.manifest?.version ?? null, error: built.check.ok ? null : built.check.errors.join('\n'),
          buildStage: null, buildStep: null, buildFiles: null, ...stats(),
          ...(current.execution ? { execution: { ...current.execution, stage: built.check.ok ? 'installing' : 'blocked', ...(built.check.ok ? {} : { reason: built.check.errors.join('\n') }) } } : {}), ...(built.check.ok ? { declared: built.declared ?? [], places: built.places ?? [] } : {}) });
      });
      if (card.execution?.mode === 'delegated' && built.check.ok && !controller.signal.aborted) {
        await this.finishDelegated(await this.status(card.id), controller);
      }
    } catch (error) {
      await this.serial(card.id, async () => {
        if (controller.signal.aborted) return;
        const current = await this.status(card.id);
        await this.store.update(card.id, current.revision, { state: 'failed', buildStage: null, buildStep: null, buildFiles: null, ...stats(), error: error instanceof Error ? error.message : String(error),
          ...(current.execution ? { execution: { ...current.execution, stage: 'blocked', reason: String(error) } } : {}) });
      });
    } finally { if (this.jobs.get(card.id) === controller) this.jobs.delete(card.id); }
  }
  /** Progress ticks share the work's lock and never bump the revision (see WorkshopStore.progress). */
  private progressOf(id: string, controller: AbortController, patch: Parameters<WorkshopStore['progress']>[1]): Promise<unknown> {
    // Best effort: a progress tick that cannot be written (e.g. Windows refusing the rename while a status read holds
    // the file) must never fail or shorten the generation it describes.
    return this.serial(id, async () => {
      if (controller.signal.aborted) return;
      try { await this.store.progress(id, patch); } catch (error) { writeHostStderr(`[plugin-workshop] progress of ${id} not recorded: ${String(error)}\n`); }
    });
  }
  /** Stop generating, or turn down a candidate waiting for installation ("不要了"); nothing is installed either way. */
  async cancel(id: string, revision: number): Promise<WorkshopCard> {
    const cancelled = await this.serial(id, async () => {
      const card = await this.expected(id, revision, ['draft', 'generating', 'pending-confirmation', 'installed', 'failed']);
      if (card.state === 'installed' && card.validation?.status !== 'pending') throw new Error('WORKSHOP_STATE: no active task to cancel');
      this.jobs.get(id)?.abort(); this.jobs.delete(id);
      return this.store.update(id, revision, { state: 'cancelled', execution: null, agentEditing: null, buildStage: null, buildStep: null, buildFiles: null });
    });
    // An activated candidate may not become the usable release merely because its verification was cancelled.
    if (cancelled.validation?.status === 'pending' && installationOf(cancelled)?.version === cancelled.validation.version) {
      await this.reportFault(id, 'WORKSHOP_CANCELLED: candidate verification cancelled', cancelled.validation.version);
      return this.serial(id, async () => {
        const current = await this.status(id);
        return this.store.update(id, current.revision, { state: 'cancelled', execution: null });
      });
    }
    return cancelled;
  }
  private async build(id: string, signal?: AbortSignal, compiled?: () => Promise<unknown>): Promise<WorkshopBuild> {
    await this.assertExecutionAllowed();
    const card = await this.status(id);
    const built = await compileWorkshop(
      join(this.store.directory(id), 'source'),
      join(this.store.directory(id), 'build'),
      card.pluginId,
      this.app,
      { displayName: card.title, description: card.description },
    );
    if (signal?.aborted) return built;
    if (built.check.compile === 'passed') await compiled?.();
    await this.checkLifecycle(built);
    if (built.check.ok) this.candidates.set(id, built);
    return built;
  }
  async isInstalledNonWorkshopPlugin(pluginId: string): Promise<boolean> {
    if (pluginId.startsWith('dstu.')) return true;
    if (!this.admin) return false;
    try {
      const inv = await this.admin.inventory();
      return inv.plugins.some(p => p.id === pluginId && p.source !== 'workshop');
    } catch {
      return false;
    }
  }
  async validate(id: string): Promise<WorkshopCheck> { return (await this.build(id)).check; }
  async stageValidated(id: string): Promise<WorkshopCheck> {
    const before = await this.status(id);
    if (['draft', 'failed', 'cancelled'].includes(before.state)) await this.normalizeSource(join(this.store.directory(id), 'source'), before);
    const built = await this.build(id);
    await this.serial(id, async () => {
      const card = await this.status(id);
      if (!['draft', 'failed', 'cancelled'].includes(card.state)) return;
      if (built.check.ok) {
        const snapshot = `${built.directory}-source`;
        await cp(built.sourceDirectory, snapshot, { recursive: true });
        built.sourceDirectory = snapshot;
        await writeFile(join(this.store.directory(card.id), 'candidate.json'), JSON.stringify(built));
        await this.store.update(card.id, card.revision, {
          state: 'pending-confirmation',
          agentEditing: null,
          check: built.check,
          version: built.manifest?.version ?? null,
          error: null,
          declared: built.declared ?? [],
          places: built.places ?? [],
        });
      } else {
        await this.store.update(card.id, card.revision, {
          agentEditing: null,
          check: built.check,
          error: built.check.errors.join('\n'),
        });
      }
    });
    return built.check;
  }
  async diagnose(id: string): Promise<unknown> {
    const card = await this.status(id);
    const inventory = await this.admin?.inventory();
    const source = join(this.store.directory(id), 'source');
    const files = await sourceFiles(source);
    return { card, runtime: inventory?.plugins.find(item => item.id === card.pluginId) ?? null,
      safeMode: inventory?.safeMode ?? false,
      files: await Promise.all(files.map(async path => ({ path, content: await readFile(join(source, path), 'utf8') }))) };
  }
  /** Renderer failures may reject a candidate; only Host-owned verification may certify it. */
  async reportValidation(id: string, version: string, revision: number, outcome: WorkshopValidationOutcome): Promise<WorkshopCard> {
    if (outcome?.ok !== false) throw new Error('WORKSHOP_VERIFICATION_REQUIRED: only runtime verification can mark a version usable');
    return this.completeValidation(id, version, revision, outcome);
  }
  private async completeValidation(id: string, version: string, revision: number, outcome: WorkshopValidationOutcome, controller?: AbortController): Promise<WorkshopCard> {
    const validated = await this.serial(id, async () => {
      const card = await this.status(id);
      if (card.pendingRestore || controller && (controller.signal.aborted || this.jobs.get(id) !== controller)
        || card.validation?.version !== version || card.validation.revision !== revision
        || card.validation.status !== 'pending' || installationOf(card)?.version !== version
        || installationOf(card)?.state !== 'installed' || card.state === 'cancelled') return null;
      const validation = { ...card.validation, status: outcome.ok ? 'passed' as const : 'failed' as const,
        detail: outcome.detail, evidence: outcome.evidence };
      return this.store.update(id, card.revision, outcome.ok ? {
        validation, usableVersion: version, lastGoodPackageDir: join(this.store.directory(id), 'versions', version, 'package'),
        verifiedVersions: { ...card.verifiedVersions, [version]: validation },
        error: null, ...(card.execution ? { execution: { ...card.execution, stage: 'complete' as const, reason: undefined } } : {}),
      } : { validation, error: outcome.detail ?? 'Runtime verification failed' });
    });
    if (!validated) return this.status(id);
    return outcome.ok ? validated : this.reportFault(id, outcome.detail ?? 'Runtime verification failed', version);
  }
  async reportFault(id: string, error: string, version?: string): Promise<WorkshopCard> {
    const failed = await this.serial(id, async () => {
      const card = await this.status(id);
      const installed = installationOf(card);
      if (card.pendingRestore || installed?.state !== 'installed' || typeof version === 'string' && installed.version !== version) return null;
      this.jobs.get(id)?.abort();
      this.jobs.delete(id);
      await this.admin?.isolateManaged?.(card.pluginId);
      const verifiedVersions = { ...card.verifiedVersions };
      delete verifiedVersions[installed.version];
      return this.store.update(id, card.revision, { ...(isOpenProposal(card.state) ? {} : { state: 'failed' as const, error }), lastFault: error,
        verifiedVersions,
        installation: { ...installed, state: 'failed' },
        ...(card.usableVersion === installed.version ? { usableVersion: null, lastGoodPackageDir: null } : {}),
        ...(card.validation?.version === installed.version ? { validation: { ...card.validation, status: 'failed', detail: error } } : {}),
        ...(card.execution && card.state !== 'cancelled' ? { execution: { ...card.execution, stage: 'repairing', reason: error } } : {}) });
    });
    if (!failed) return this.status(id);
    return this.recoverAndRepair(failed, error, installationOf(failed)?.version);
  }
  private async recoverAndRepair(failed: WorkshopCard, error: string, badVersion?: string | null): Promise<WorkshopCard> {
    const id = failed.id;
    // The verified pointer is authoritative for new records; legacy/manual installations still retain their predecessor.
    const previous = failed.usableVersion && failed.usableVersion !== badVersion ? failed.usableVersion
      : installationOf(failed)?.previousVersion ?? (isOpenProposal(failed.state) ? null : failed.previousVersion);
    let recovered = failed;
    if (previous && previous !== badVersion && !(installationOf(failed)?.state === 'installed' && installationOf(failed)?.version === previous)) {
      try { recovered = await this.restoreVersion(id, failed.revision, true); }
      catch (cause) {
        const current = await this.status(id);
        return this.store.update(id, current.revision, { state: 'failed', rollback: 'failed', error: `${error}\nRecovery: ${String(cause)}`,
          ...(current.execution ? { execution: { ...current.execution, stage: 'blocked', reason: String(cause) } } : {}) });
      }
    }
    if (recovered.execution?.mode === 'delegated' && this.generation && !this.disposed && !['cancelled', 'revoked'].includes(recovered.state)) {
      // Keep the original goal and failed source. Recovery must not silently replace the requested change with the old version.
      const repair = await this.serial(id, async () => {
        const current = await this.status(id);
        if (current.execution?.stage !== 'repairing') return null;
        return this.store.update(id, current.revision, { state: 'failed', error,
          execution: { ...current.execution, stage: 'repairing', reason: error } });
      });
      if (repair) {
        try { return await this.startGeneration(id, repair.revision, undefined, undefined, true); }
        catch (cause) { return this.blockExecution(id, String(cause)); }
      }
    }
    return recovered;
  }
  writeSource(id: string, revision: number, files: SourceFile[]): Promise<WorkshopCard> {
    return this.serial(id, async () => {
      // While the Host generates, the work is the Host's: an Agent edit would race it (it used to abort it).
      const current = await this.expected(id, revision, ['draft', 'failed', 'cancelled']);
      await writeSourceFiles(join(this.store.directory(id), 'source'), files);
      return this.store.update(id, revision, { state: current.state, check: null, error: null, agentEditing: new Date().toISOString() });
    });
  }
  /**
   * The values the user entered on the card become the running plugin's config (hot update, persisted in the
   * profile). Best effort: the plugin is installed either way and says what is missing when used.
   */
  private async applySettings(card: WorkshopCard): Promise<void> {
    const values = settingValues(card.settings);
    if (!values || !this.admin?.configureManaged) return;
    try { await this.admin.configureManaged(card.pluginId, values); }
    catch (error) { writeHostStderr(`[plugin-workshop] settings of ${card.pluginId} not applied: ${String(error)}\n`); }
  }
  private owner(): WorkshopAdmin {
    if (!this.admin) throw new Error('WORKSHOP_INSTALL_UNAVAILABLE: kernel admin is not bound');
    return this.admin;
  }
  install(id: string, revision: number): Promise<WorkshopCard> {
    return this.serial(id, async () => {
      const card = await this.expected(id, revision, ['pending-confirmation']);
      if (card.pendingRestore) throw new Error('WORKSHOP_STATE: finish the pending rollback first');
      await this.assertExecutionAllowed();
      const owner = this.owner();
      // User approved the frozen build, not whatever source the Agent edited afterwards.
      const built = JSON.parse(await readFile(join(this.store.directory(id), 'candidate.json'), 'utf8')) as WorkshopBuild;
      if (!isManagedChild(await realpath(join(this.store.directory(id), 'build')), await realpath(built.directory))) throw new Error('WORKSHOP_INVALID: candidate is outside managed builds');
      await this.checkLifecycle(built);
      if (!built.check.ok || !built.manifest) throw new Error(`WORKSHOP_INVALID: ${built.check.errors.join('\n')}`);
      const inventory = await owner.inventory();
      if (!inventory.revision) throw new Error('WORKSHOP_INSTALL_UNAVAILABLE: profile is read-only');
      // Retention must succeed before committing the package, not after a successful install.
      const versionRoot = join(this.store.directory(id), 'versions', built.manifest.version);
      await mkdir(versionRoot, { recursive: true });
      await cp(built.directory, join(versionRoot, 'package'), { recursive: true });
      await cp(built.sourceDirectory, join(versionRoot, 'source'), { recursive: true });
      await writeFile(join(versionRoot, 'manifest.json'), JSON.stringify(built.manifest));
      const pending = await this.store.update(id, revision, {
        validation: { version: built.manifest.version, revision: revision + 1, status: 'pending' },
        ...(card.execution ? { execution: { ...card.execution, stage: 'installing' } } : {}),
      });
      try {
        const result = await owner.installManagedDirectory({ id: card.pluginId, directory: built.directory, revision: inventory.revision,
          version: built.manifest.version, permissions: built.manifest.permissions, confirmed: true });
        if (owner.activateManaged) await owner.activateManaged(card.pluginId, result.revision);
      } catch (error) {
        const value = error instanceof CommandError ? error.value : error;
        const rollback = (value as { details?: { rollback?: string } } | null)?.details?.rollback;
        const actual = (await owner.inventory()).plugins.find(item => item.id === card.pluginId);
        if (actual?.version === built.manifest.version) await owner.isolateManaged?.(card.pluginId);
        const before = installationOf(card);
        const installation: WorkshopInstallation | null = actual?.state === 'running' && actual.version && actual.version !== built.manifest.version
          ? { state: 'installed', version: actual.version, previousVersion: null }
          : { state: 'failed', version: built.manifest.version, previousVersion: card.usableVersion ?? before?.version ?? null };
        await this.store.update(id, pending.revision, { state: 'failed', error: error instanceof Error ? error.message : String(error), previousVersion: card.previousVersion, installation,
          validation: { ...pending.validation!, status: 'failed', detail: String(error) },
          ...(rollback === 'not-needed' || rollback === 'restored' || rollback === 'failed' ? { rollback } : {}) });
        throw error;
      }
      await this.applySettings(card);
      const before = installationOf(card);
      const installation: WorkshopInstallation = { state: 'installed', version: built.manifest.version,
        previousVersion: card.usableVersion && card.usableVersion !== built.manifest.version ? card.usableVersion
          : before && before.version !== built.manifest.version ? before.version : before?.previousVersion ?? null };
      return this.store.update(id, pending.revision, { state: 'installed', version: built.manifest.version, check: built.check, error: null, installation,
        validation: pending.validation, declared: built.declared ?? [], places: built.places ?? [],
        ...(card.execution ? { execution: { ...card.execution, stage: 'validating' } } : {}) });
    }).then(card => {
      if (!card.execution) this.startVerification(card);
      return card;
    });
  }
  /**
   * Uninstall a managed work. This is the only removal path for workshop plugins (the manager's 卸载 calls it too),
   * so the chat card, the workshop record and the manager list agree. Retained versions and the plugin's own data
   * stay on disk; `restore` reinstalls the last usable version. A failed (isolated) work can be removed as well;
   * a work the user already removed elsewhere is only marked.
   */
  revoke(id: string, revision: number): Promise<WorkshopCard> {
    return this.serial(id, async () => {
      // Only what is installed matters: a modification proposal in progress (or turned down) never blocks 卸载.
      const card = await this.store.read(id);
      if (card.revision !== revision) throw new Error('WORKSHOP_CONFLICT: confirmation is stale');
      const installed = installationOf(card);
      if (!(installed && installed.state !== 'revoked') && card.state !== 'failed') throw new Error(`WORKSHOP_STATE: cannot act in ${installed?.state ?? card.state}`);
      this.jobs.get(id)?.abort(); this.jobs.delete(id);
      const owner = this.owner(), inventory = await owner.inventory();
      if (inventory.plugins.some(entry => entry.id === card.pluginId)) {
        if (!inventory.revision) throw new Error('WORKSHOP_INSTALL_UNAVAILABLE: profile is read-only');
        await owner.uninstall(card.pluginId, inventory.revision);
      }
      return this.store.update(id, revision, { execution: null, validation: null, pendingRestore: null, ...(isOpenProposal(card.state) ? {} : { state: 'revoked' as const }),
        installation: installed ? { ...installed, state: 'revoked' } : null });
    });
  }
  restore(id: string, revision: number): Promise<WorkshopCard> {
    return this.restoreVersion(id, revision, false);
  }
  private restoreVersion(id: string, revision: number, repair: boolean): Promise<WorkshopCard> {
    return this.serial(id, async () => {
      let card = await this.store.read(id);
      if (card.revision !== revision) throw new Error('WORKSHOP_CONFLICT: confirmation is stale');
      const installed = installationOf(card);
      if (!installed && !['revoked', 'failed', 'installed'].includes(card.state)) throw new Error(`WORKSHOP_STATE: cannot act in ${card.state}`);
      await this.assertExecutionAllowed();
      const owner = this.owner(), inventory = await owner.inventory();
      // Installed in the record but gone from the manager (removed outside the workshop): bring back this version.
      const removed = installed?.state === 'revoked' || (installed?.state === 'installed' && !inventory.plugins.some(entry => entry.id === card.pluginId));
      let pending = card.pendingRestore;
      const retainedVersion = pending?.version ?? (removed ? card.usableVersion ?? installed?.version
        : card.usableVersion && card.usableVersion !== installed?.version ? card.usableVersion : installed?.previousVersion ?? (isOpenProposal(card.state) ? null : card.previousVersion) ?? card.usableVersion);
      if (!retainedVersion) throw new Error('WORKSHOP_STATE: no successful version retained');
      if (!inventory.revision) throw new Error('WORKSHOP_INSTALL_UNAVAILABLE: profile is read-only');
      const active = inventory.plugins.find(entry => entry.id === card.pluginId);
      if (pending && active?.source === 'workshop' && active.version === retainedVersion && active.state === 'running') {
        await this.applySettings(card);
        return this.recordRestore(card, pending);
      }
      const built = await compileWorkshop(join(this.store.directory(id), 'versions', retainedVersion, 'source'),
        join(this.store.directory(id), 'build'), card.pluginId, this.app, { displayName: card.title, description: card.description });
      await this.checkLifecycle(built);
      if (!built.check.ok || built.manifest?.version !== retainedVersion) throw new Error(`WORKSHOP_INVALID: cannot restore ${retainedVersion}: ${built.check.errors.join('\n')}`);
      if (!pending) {
        pending = { version: retainedVersion, previousVersion: removed ? installed?.previousVersion ?? null : null,
          repair, check: built.check, declared: built.declared ?? [], places: built.places ?? [] };
        card = await this.store.update(id, revision, { pendingRestore: pending });
      }
      if (!isOpenProposal(card.state)) { this.jobs.get(id)?.abort(); this.jobs.delete(id); }
      const result = await owner.installManagedDirectory({ id: card.pluginId, directory: built.directory, revision: inventory.revision,
        version: retainedVersion, permissions: built.manifest.permissions, confirmed: true });
      if (owner.activateManaged) await owner.activateManaged(card.pluginId, result.revision);
      await this.applySettings(card);
      return this.recordRestore(card, pending);
    });
  }
  private recordRestore(card: WorkshopCard, restored: Pick<NonNullable<WorkshopCard['pendingRestore']>, 'version' | 'previousVersion' | 'repair'> & Partial<Pick<WorkshopCard, 'check' | 'declared' | 'places'>>): Promise<WorkshopCard> {
    const { id } = card;
    const { version, previousVersion, repair } = restored;
    const installation: WorkshopInstallation = { state: 'installed', version, previousVersion };
    const validation = card.verifiedVersions?.[version]
      ?? (card.validation?.version === version && card.validation.status === 'passed' ? card.validation : null);
    const usable = validation?.status === 'passed' || card.usableVersion === version;
    const recovery = { installation, rollback: 'restored' as const, pendingRestore: null,
      usableVersion: usable ? version : null,
      lastGoodPackageDir: usable ? join(this.store.directory(id), 'versions', version, 'package') : null };
    // A separate proposal may still be in progress. Preserve its step and source.
    if (isOpenProposal(card.state)) return this.store.update(id, card.revision, { ...recovery, previousVersion: version });
    this.jobs.get(id)?.abort(); this.jobs.delete(id);
    return this.store.update(id, card.revision, { state: 'installed', version, previousVersion, validation,
      check: restored.check ?? null, declared: restored.declared, places: restored.places, error: repair ? card.error : null,
      execution: repair && card.execution ? { ...card.execution, stage: 'repairing' } : null, ...recovery });
  }
  /**
   * The package of the approved version in use (the immutable `versions/<v>/package` the user installed), never a
   * rebuild of `source/`, which may hold an unapproved or failed modification.
   */
  async export(id: string): Promise<WorkshopExport> {
    const card = await this.status(id);
    const root = this.store.directory(id);
    const installed = installationOf(card);
    const candidates = [card.lastGoodPackageDir, card.usableVersion && join(root, 'versions', card.usableVersion, 'package'),
      installed && join(root, 'versions', installed.version, 'package')].filter((item): item is string => Boolean(item));
    let directory: string | undefined;
    for (const candidate of candidates) {
      if (!isManagedChild(root, candidate)) continue;
      const manifest = await stat(join(candidate, 'package.json')).catch(() => null);
      if (manifest?.isFile()) { directory = candidate; break; }
    }
    if (!directory) throw new Error('WORKSHOP_STATE: no installed version to export yet; install it first');
    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
      version?: unknown;
      deepStudent?: { kind?: unknown };
    };
    const version = typeof pkg.version === 'string' ? pkg.version : installed?.version ?? card.usableVersion ?? '0.0.0';
    const kind = pkg.deepStudent?.kind === 'study-pack' ? 'study-pack' : 'plugin';
    const archive = new JSZip();
    for (const file of await sourceFiles(directory)) archive.file(file.replaceAll('\\', '/'), await readFile(join(directory, file)));
    const fileName = exportFileName(card.title, version, kind);
    await mkdir(join(root, 'exports'), { recursive: true });
    const path = join(root, 'exports', fileName);
    await writeFile(path, await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    return { id, version, path, fileName };
  }

  private async resolvePluginStorageDir(pluginId: string): Promise<string | null> {
    if (!isValidPluginId(pluginId)) throw new Error('WORKSHOP_INVALID: invalid plugin id');
    const pluginsRoot = join(this.app.dataDir, 'plugins');
    const target = join(pluginsRoot, pluginId);
    if (!isManagedChild(pluginsRoot, target)) throw new Error('WORKSHOP_INVALID: plugin data directory outside plugins root');
    const rel = relative(pluginsRoot, target);
    if (rel === 'releases' || rel.startsWith('releases/') || rel.startsWith('releases\\')) {
      throw new Error('WORKSHOP_INVALID: cannot access plugin releases directory');
    }
    const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
      throw error;
    });
    if (!info || info.isSymbolicLink() || !info.isDirectory()) return null;
    const [realRoot, realTarget] = await Promise.all([realpath(pluginsRoot), realpath(target)]);
    if (!isManagedChild(realRoot, realTarget)) throw new Error('WORKSHOP_INVALID: plugin data directory escaped plugins root');
    const realRel = relative(realRoot, realTarget);
    if (realRel === 'releases' || realRel.startsWith('releases/') || realRel.startsWith('releases\\')) {
      throw new Error('WORKSHOP_INVALID: cannot access plugin releases directory');
    }
    return realTarget;
  }

  private async walkPluginStorageFiles(root: string): Promise<Array<{ key: string; bytes: number }>> {
    const items: Array<{ key: string; bytes: number }> = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        const info = await lstat(full).catch(() => null);
        if (!info || info.isSymbolicLink()) continue;
        if (info.isDirectory()) {
          const realDir = await realpath(full).catch(() => null);
          if (realDir && isManagedChild(root, realDir)) await walk(realDir);
        } else if (info.isFile()) {
          items.push({ key: relative(root, full).replaceAll('\\', '/'), bytes: info.size });
        }
      }
    };
    await walk(root);
    return items;
  }

  /** Lists Host-persisted plugin data under `<appDataDir>/plugins/<pluginId>/` and `${pluginId}.*` settings. */
  async storedData(pluginId: string): Promise<WorkshopStoredData> {
    const dir = await this.resolvePluginStorageDir(pluginId);
    const fileItems = dir ? await this.walkPluginStorageFiles(dir) : [];
    const keys = fileItems.map(item => item.key);
    let bytes = fileItems.reduce((sum, item) => sum + item.bytes, 0);
    const settings = this.settingsReader?.();
    if (settings) {
      for (const row of settings.listByPrefix(`${pluginId}.`)) {
        keys.push(row.key);
        bytes += Buffer.byteLength(row.key, 'utf8') + Buffer.byteLength(row.value, 'utf8');
      }
    }
    return { keys: [...new Set(keys)].sort(), bytes };
  }

  /** Clears Host-persisted plugin data under `<appDataDir>/plugins/<pluginId>/` and `${pluginId}.*` settings without touching `releases/`. */
  async clearStoredData(pluginId: string): Promise<number> {
    const dir = await this.resolvePluginStorageDir(pluginId);
    let removed = 0;
    if (dir) {
      const fileItems = await this.walkPluginStorageFiles(dir);
      removed += fileItems.length;
      await rm(dir, { recursive: true, force: true });
    }
    const settings = this.settingsReader?.();
    if (settings) {
      removed += settings.deleteByPrefix(`${pluginId}.`);
    }
    return removed;
  }
}
