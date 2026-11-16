// RUST-FIX(RF-P3-workshop-tools): user-owned generation, cancellation and retained-version recovery.
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { CommandError, type AppInfo, type PluginManagerConfigView, type PluginManagerInventory, type PluginManagerInstallResult } from '../../../kernel/api.ts';
import type { PluginWorkshopService, WorkshopBrief, WorkshopCard, WorkshopCheck, WorkshopExport, WorkshopInstallation } from '../api.ts';
import { OPEN_PROPOSAL_STATES, WorkshopStore, installationOf, withBoundSession } from './store.ts';
import { compileWorkshop, checkWorkshopLifecycle, sourceFiles, type WorkshopBuild } from './compiler.ts';
import { parseDegradedReason } from '../../../kernel/plugin-load-error.ts';
import { writeHostStderr } from '../../../kernel/kernel.ts';
import { isManagedChild } from './paths.ts';
import { realpath } from 'node:fs/promises';
import { writeSourceFiles, type SourceFile } from './source.ts';
import type { WorkshopActivationResult, WorkshopSelfCheckContext } from '../../../kernel/plugin-admin.ts';
import { checkSettingLinks, fillSettings, normalizeWorkshopSource, settingValues, storeSecretSettings, type WorkshopLinkReader, type WorkshopSecretStore } from './settings.ts';

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
/** `<标题>-v<version>.dstuplugin`: a file name a learner recognises, safe on every file system. */
export function exportFileName(title: string, version: string): string {
  const safe = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 60).trim() || 'plugin';
  return `${safe}-v${version}.dstuplugin`;
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
  generate(card: WorkshopCard, source: string, signal: AbortSignal, progress?: (files: string[]) => void): Promise<void | { tokens?: number }>;
}
export class WorkshopOperations implements Omit<PluginWorkshopService, 'developmentSkill'> {
  readonly store: WorkshopStore;
  readonly app: AppInfo;
  private admin: WorkshopAdmin | null = null;
  private restart: (() => Promise<unknown>) | null = null;
  private generation: WorkshopGeneration | null = null;
  private linkReader: WorkshopLinkReader | null = null;
  private readonly jobs = new Map<string, AbortController>();
  private readonly candidates = new Map<string, WorkshopBuild>();
  private readonly locks = new Map<string, Promise<unknown>>();
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
      if (card.version !== result.attemptedVersion) return;
      const installed = installationOf(card);
      if (result.success) {
        const recovered = card.state === 'failed' && installed?.state === 'failed';
        await this.store.update(card.id, card.revision, { usableVersion: result.actualVersion,
          ...(recovered ? { state: 'installed' as const, error: null, lastFault: null } : {}),
          lastGoodPackageDir: join(this.store.directory(card.id), 'versions', result.actualVersion!, 'package'),
          ...(result.actualVersion ? { installation: { previousVersion: null, ...installed, state: 'installed' as const, version: result.actualVersion } } : {}) });
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
  /** HTTPS reader for the calendar-address check (WorkshopSetting `ics-url`). */
  bindLinkReader(reader: WorkshopLinkReader): void { this.linkReader = reader; }
  private secretStore: WorkshopSecretStore | null = null;
  /** Where card secrets go (the settings service's secure store, under the plugin's pluginSecrets key). */
  bindSecretStore(store: WorkshopSecretStore): void { this.secretStore = store; }
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
    for (const card of await this.store.list()) {
      const installed = inventory.plugins.find(entry => entry.id === card.pluginId);
      const installation = installationOf(card);
      if (installed?.state === 'running' && installed.version === card.version && card.usableVersion !== card.version) {
        await this.store.update(card.id, card.revision, { usableVersion: card.version,
          lastGoodPackageDir: join(this.store.directory(card.id), 'versions', card.version!, 'package'),
          ...(installation?.version === card.version ? { installation: { ...installation, state: 'installed' as const } } : {}) });
      } else if (installed?.state === 'degraded' && installation?.state === 'installed' && !isCompatibilityFailure(installed.reason)) {
        await this.reportFault(card.id, installed.reason ?? 'Plugin activation failed');
      } else if (installed?.state === 'running' && installed.version && installed.version === card.previousVersion && card.state === 'installed' && installed.version !== card.version) {
        await this.store.update(card.id, card.revision, { state: 'failed', error: 'Installed candidate is not active; retained version is running', usableVersion: installed.version,
          installation: { previousVersion: null, ...installation, state: 'installed', version: installed.version } });
      }
    }
  }
  dispose(): void { this.unobserve?.(); this.unobserveFaults?.(); for (const controller of this.jobs.values()) controller.abort(); }
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
    const card = await this.store.propose(brief);
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
      await rm(this.store.directory(id), { recursive: true, force: true, maxRetries: 3 });
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
    return this.serial(id, async () => {
      await this.assertExecutionAllowed();
      const current = await this.expected(id, revision, ['draft', 'cancelled', 'failed']);
      const generation = this.generation;
      if (!generation) throw new Error('WORKSHOP_GENERATION_UNAVAILABLE: chat pipeline is not ready');
      const settings = current.settings?.length ? await storeSecretSettings(current.pluginId, fillSettings(current.settings, values), this.secretStore) : undefined;
      // A new (or restarted) modification starts from the version in use, not from the last attempt's leftovers;
      // only a failed attempt is continued where it stopped (「让 AI 接着修」 / 「继续做」).
      if (current.state !== 'failed') await this.startFromInstalled(current);
      const card = await this.store.update(id, revision, { state: 'generating', check: null, error: null, generationApproved: true,
        agentEditing: null, buildAttempt: 0, buildStage: null, buildFiles: null, buildStep: null, ...(settings ? { settings } : {}),
        generation: { startedAt: new Date().toISOString() } });
      const controller = new AbortController();
      this.jobs.set(id, controller);
      void this.run(card, controller, generation).catch(error => {
        writeHostStderr(`[plugin-workshop] background task ${id} failed to persist: ${String(error)}\n`);
      });
      return card;
    });
  }
  /**
   * Put the source of the version in use back into `source/` before a modification is made. The previous draft is kept
   * under `drafts/<revision>` (never deleted), so nothing the AI wrote is lost, but none of it leaks into this change.
   */
  private async startFromInstalled(card: WorkshopCard): Promise<void> {
    const version = card.usableVersion ?? installationOf(card)?.version;
    if (!version) return;
    const root = this.store.directory(card.id);
    const retained = join(root, 'versions', version, 'source');
    try { if (!(await stat(retained)).isDirectory()) return; } catch { return; }
    const source = join(root, 'source');
    if ((await sourceFiles(source).catch(() => [])).length) {
      const draft = join(root, 'drafts', String(card.revision));
      await rm(draft, { recursive: true, force: true });
      await mkdir(join(root, 'drafts'), { recursive: true });
      await cp(source, draft, { recursive: true });
    }
    await rm(source, { recursive: true, force: true, maxRetries: 3 });
    await cp(retained, source, { recursive: true });
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
      for (let attempt = 1; attempt <= 3; attempt++) {
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
          // Host bookkeeping (a version above the retained one, net:<host> of the user's address) is not a repair round.
          await normalizeWorkshopSource(source, card);
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
        // Safe mode, an app feature that is turned off, …: the code is not the problem, so no repair round.
        if (isEnvironmentError(task.error)) break;
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
          buildStage: null, buildStep: null, buildFiles: null, ...stats(), ...(built.check.ok ? { declared: built.declared ?? [], places: built.places ?? [] } : {}) });
      });
    } catch (error) {
      await this.serial(card.id, async () => {
        if (controller.signal.aborted) return;
        const current = await this.status(card.id);
        await this.store.update(card.id, current.revision, { state: 'failed', buildStage: null, buildStep: null, buildFiles: null, ...stats(), error: error instanceof Error ? error.message : String(error) });
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
  cancel(id: string, revision: number): Promise<WorkshopCard> {
    return this.serial(id, async () => {
      await this.expected(id, revision, ['draft', 'generating', 'pending-confirmation']);
      this.jobs.get(id)?.abort();
      return this.store.update(id, revision, { state: 'cancelled', agentEditing: null, buildStage: null, buildStep: null, buildFiles: null });
    });
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
    if (['draft', 'failed', 'cancelled'].includes(before.state)) await normalizeWorkshopSource(join(this.store.directory(id), 'source'), before);
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
  async reportFault(id: string, error: string): Promise<WorkshopCard> {
    const failed = await this.serial(id, async () => {
      const card = await this.status(id);
      const installed = installationOf(card);
      if (installed?.state !== 'installed') return null;
      await this.admin?.isolateManaged?.(card.pluginId);
      // A proposal in progress keeps its own state; the installed version is what failed.
      return this.store.update(id, card.revision, { ...(isOpenProposal(card.state) ? {} : { state: 'failed' as const, error }), lastFault: error,
        installation: { ...installed, state: 'failed' } });
    });
    if (!failed) return this.status(id);
    // Never retry the same bad release. Recovery only runs an earlier approved source snapshot.
    const failedInstallation = installationOf(failed);
    const previous = failedInstallation?.previousVersion ?? (isOpenProposal(failed.state) ? null : failed.previousVersion);
    if (previous && previous !== failedInstallation?.version) {
      try { return await this.restore(id, failed.revision); }
      catch (cause) {
        const current = await this.status(id);
        return this.store.update(id, current.revision, { state: 'failed', rollback: 'failed', error: `${error}\nRecovery: ${String(cause)}` });
      }
    }
    return failed;
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
      try {
        const result = await owner.installManagedDirectory({ id: card.pluginId, directory: built.directory, revision: inventory.revision,
          version: built.manifest.version, permissions: built.manifest.permissions, confirmed: true });
        if (owner.activateManaged) await owner.activateManaged(card.pluginId, result.revision);
      } catch (error) {
        const value = error instanceof CommandError ? error.value : error;
        const rollback = (value as { details?: { rollback?: string } } | null)?.details?.rollback;
        await this.store.update(id, revision, { state: 'failed', error: error instanceof Error ? error.message : String(error), previousVersion: card.previousVersion,
          ...(rollback === 'not-needed' || rollback === 'restored' || rollback === 'failed' ? { rollback } : {}) });
        throw error;
      }
      await this.applySettings(card);
      const active = (await owner.inventory()).plugins.find(item => item.id === card.pluginId);
      const before = installationOf(card);
      const installation: WorkshopInstallation = { state: 'installed', version: built.manifest.version,
        previousVersion: before && before.version !== built.manifest.version ? before.version : before?.previousVersion ?? null };
      return this.store.update(id, revision, { state: 'installed', version: built.manifest.version, check: built.check, error: null, installation,
        declared: built.declared ?? [], places: built.places ?? [],
        ...(active?.state === 'running' ? { usableVersion: built.manifest.version, lastGoodPackageDir: join(versionRoot, 'package') } : {}) });
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
      const owner = this.owner(), inventory = await owner.inventory();
      if (inventory.plugins.some(entry => entry.id === card.pluginId)) {
        if (!inventory.revision) throw new Error('WORKSHOP_INSTALL_UNAVAILABLE: profile is read-only');
        await owner.uninstall(card.pluginId, inventory.revision);
      }
      return this.store.update(id, revision, { ...(isOpenProposal(card.state) ? {} : { state: 'revoked' as const }),
        installation: installed ? { ...installed, state: 'revoked' } : null });
    });
  }
  restore(id: string, revision: number): Promise<WorkshopCard> {
    return this.serial(id, async () => {
      const card = await this.store.read(id);
      if (card.revision !== revision) throw new Error('WORKSHOP_CONFLICT: confirmation is stale');
      const installed = installationOf(card);
      if (!installed && !['revoked', 'failed', 'installed'].includes(card.state)) throw new Error(`WORKSHOP_STATE: cannot act in ${card.state}`);
      await this.assertExecutionAllowed();
      const owner = this.owner(), inventory = await owner.inventory();
      // Installed in the record but gone from the manager (removed outside the workshop): bring back this version.
      const removed = installed?.state === 'revoked' || (installed?.state === 'installed' && !inventory.plugins.some(entry => entry.id === card.pluginId));
      const retainedVersion = removed ? card.usableVersion ?? installed?.version
        : installed?.previousVersion ?? (isOpenProposal(card.state) ? null : card.previousVersion) ?? card.usableVersion;
      if (!retainedVersion) throw new Error('WORKSHOP_STATE: no successful version retained');
      if (!inventory.revision) throw new Error('WORKSHOP_INSTALL_UNAVAILABLE: profile is read-only');
      const versionRoot = join(this.store.directory(id), 'versions', retainedVersion);
      const built = await compileWorkshop(
        join(versionRoot, 'source'),
        join(this.store.directory(id), 'build'),
        card.pluginId,
        this.app,
        { displayName: card.title, description: card.description },
      );
      await this.checkLifecycle(built);
      if (!built.check.ok || !built.manifest) throw new Error(`WORKSHOP_INVALID: ${built.check.errors.join('\n')}`);
      const result = await owner.installManagedDirectory({ id: card.pluginId, directory: built.directory, revision: inventory.revision,
        version: built.manifest.version, permissions: built.manifest.permissions, confirmed: true });
      if (owner.activateManaged) await owner.activateManaged(card.pluginId, result.revision);
      await this.applySettings(card);
      const installation: WorkshopInstallation = { state: 'installed', version: retainedVersion,
        previousVersion: removed ? installed?.previousVersion ?? null : null };
      // A proposal in progress keeps its own step and candidate; only the installed version changes.
      if (isOpenProposal(card.state)) {
        return this.store.update(id, revision, { installation, rollback: 'restored',
          ...(owner.activateManaged ? { usableVersion: retainedVersion, lastGoodPackageDir: join(versionRoot, 'package') } : {}) });
      }
      return this.store.update(id, revision, { state: 'installed', version: retainedVersion, check: built.check, error: null, rollback: 'restored', installation,
        declared: built.declared ?? [], places: built.places ?? [],
        ...(owner.activateManaged ? { usableVersion: retainedVersion, lastGoodPackageDir: join(versionRoot, 'package') } : {}) });
    });
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
      try { if ((await stat(join(candidate, 'package.json'))).isFile()) { directory = candidate; break; } } catch { /* try the next one */ }
    }
    if (!directory) throw new Error('WORKSHOP_STATE: no installed version to export yet; install it first');
    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { version?: unknown };
    const version = typeof pkg.version === 'string' ? pkg.version : installed?.version ?? card.usableVersion ?? '0.0.0';
    const archive = new JSZip();
    for (const file of await sourceFiles(directory)) archive.file(file.replaceAll('\\', '/'), await readFile(join(directory, file)));
    const fileName = exportFileName(card.title, version);
    await mkdir(join(root, 'exports'), { recursive: true });
    const path = join(root, 'exports', fileName);
    await writeFile(path, await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    return { id, version, path, fileName };
  }
}
