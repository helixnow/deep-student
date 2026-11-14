// RUST-FIX(RF-P3-workshop-tools): user-owned generation, cancellation and retained-version recovery.
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { CommandError, type AppInfo, type PluginManagerConfigView, type PluginManagerInventory, type PluginManagerInstallResult } from '../../../kernel/api.ts';
import type { PluginWorkshopService, WorkshopBrief, WorkshopCard, WorkshopCheck, WorkshopExport } from '../api.ts';
import { WorkshopStore } from './store.ts';
import { compileWorkshop, checkWorkshopLifecycle, sourceFiles, type WorkshopBuild } from './compiler.ts';
import { parseDegradedReason } from '../../../kernel/plugin-load-error.ts';
import { writeHostStderr } from '../../../kernel/kernel.ts';
import { isManagedChild } from './paths.ts';
import { realpath } from 'node:fs/promises';
import { writeSourceFiles, type SourceFile } from './source.ts';
import type { WorkshopActivationResult, WorkshopSelfCheckContext } from '../../../kernel/plugin-admin.ts';

// Compatibility failures belong to the running app version. Keep the
// installed revision enabled on disk so another app version can load it.
function isCompatibilityFailure(reason: string | undefined): boolean {
  const code = reason === undefined ? undefined : parseDegradedReason(reason).code;
  return code === 'ENGINE_INCOMPATIBLE' || code === 'MANIFEST_VERSION_UNSUPPORTED'
    || code === 'REQUIRES_INCOMPATIBLE' || code === 'REQUIRES_MISSING'
    || code === 'UNSUPPORTED_ON_PLATFORM';
}

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
  generate(card: WorkshopCard, source: string, signal: AbortSignal): Promise<void>;
}
export class WorkshopOperations implements Omit<PluginWorkshopService, 'developmentSkill'> {
  readonly store: WorkshopStore;
  readonly app: AppInfo;
  private admin: WorkshopAdmin | null = null;
  private restart: (() => Promise<unknown>) | null = null;
  private generation: WorkshopGeneration | null = null;
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
      const card = (await this.store.list()).find(item => item.pluginId === id && item.state === 'installed');
      if (card && !isCompatibilityFailure(reason)) await this.reportFault(card.id, reason);
    }) ?? null;
  }
  private async activationResult(result: WorkshopActivationResult): Promise<void> {
    const work = (await this.store.list()).find(card => card.pluginId === result.id);
    if (!work) return;
    await this.serial(work.id, async () => {
      const card = await this.store.read(work.id);
      if (card.version !== result.attemptedVersion) return;
      await this.store.update(card.id, card.revision, result.success ? { usableVersion: result.actualVersion, error: null,
        lastGoodPackageDir: join(this.store.directory(card.id), 'versions', result.actualVersion!, 'package') }
        : { state: 'failed', error: result.error, ...(result.rollback ? { rollback: result.rollback } : {}) });
    });
  }
  bindGeneration(generation: WorkshopGeneration): void { this.generation = generation; }
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
      if (installed?.state === 'running' && installed.version === card.version && card.usableVersion !== card.version) {
        await this.store.update(card.id, card.revision, { usableVersion: card.version,
          lastGoodPackageDir: join(this.store.directory(card.id), 'versions', card.version!, 'package') });
      } else if (installed?.state === 'degraded' && card.state === 'installed' && !isCompatibilityFailure(installed.reason)) {
        await this.reportFault(card.id, installed.reason ?? 'Plugin activation failed');
      } else if (installed?.state === 'running' && installed.version === card.previousVersion && card.state === 'installed' && installed.version !== card.version) {
        await this.store.update(card.id, card.revision, { state: 'failed', error: 'Installed candidate is not active; retained version is running', usableVersion: installed.version });
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
  propose(brief: WorkshopBrief): Promise<WorkshopCard> { return this.store.propose(brief); }
  bindSession(id: string, revision: number, sessionId: string): Promise<WorkshopCard> {
    return this.serial(id, async () => {
      if (!sessionId.trim()) throw new Error('WORKSHOP_INVALID: editing session is required');
      await this.expected(id, revision, ['draft', 'installed', 'revoked', 'failed', 'cancelled']);
      return this.store.update(id, revision, { sessionId });
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
  create(id: string, revision: number): Promise<WorkshopCard> {
    return this.serial(id, async () => {
      await this.assertExecutionAllowed();
      await this.expected(id, revision, ['draft', 'cancelled', 'failed']);
      const generation = this.generation;
      if (!generation) throw new Error('WORKSHOP_GENERATION_UNAVAILABLE: chat pipeline is not ready');
      const card = await this.store.update(id, revision, { state: 'generating', check: null, error: null });
      const controller = new AbortController();
      this.jobs.set(id, controller);
      void this.run(card, controller, generation).catch(error => {
        writeHostStderr(`[plugin-workshop] background task ${id} failed to persist: ${String(error)}\n`);
      });
      return card;
    });
  }
  private async run(card: WorkshopCard, controller: AbortController, generation: WorkshopGeneration): Promise<void> {
    try {
      let built: WorkshopBuild | undefined;
      // A bounded repair conversation: exact compiler/lifecycle errors become the next task.
      let task = card;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await generation.generate(task, join(this.store.directory(card.id), 'source'), controller.signal);
          if (controller.signal.aborted) return;
          built = await this.build(card.id, controller.signal);
          if (card.previousVersion && built.manifest?.version === card.previousVersion) {
            built.check.ok = false;
            built.check.errors.push('WORKSHOP_INVALID: an update must use a new package and module version');
          }
          task = { ...task, check: built.check, error: built.check.errors.join('\n') };
        } catch (error) {
          task = { ...task, error: error instanceof Error ? error.message : String(error) };
          built = undefined;
        }
        await this.serial(card.id, async () => {
          if (controller.signal.aborted) return;
          const current = await this.status(card.id);
          await this.store.update(card.id, current.revision, { buildAttempt: attempt, check: task.check, error: task.error });
        });
        if (controller.signal.aborted) return;
        if (built?.check.ok) break;
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
          check: built.check, version: built.manifest?.version ?? null, error: built.check.ok ? null : built.check.errors.join('\n') });
      });
    } catch (error) {
      await this.serial(card.id, async () => {
        if (controller.signal.aborted) return;
        const current = await this.status(card.id);
        await this.store.update(card.id, current.revision, { state: 'failed', error: error instanceof Error ? error.message : String(error) });
      });
    } finally { if (this.jobs.get(card.id) === controller) this.jobs.delete(card.id); }
  }
  cancel(id: string, revision: number): Promise<WorkshopCard> {
    return this.serial(id, async () => {
      await this.expected(id, revision, ['draft', 'generating']);
      this.jobs.get(id)?.abort();
      return this.store.update(id, revision, { state: 'cancelled' });
    });
  }
  private async build(id: string, signal?: AbortSignal): Promise<WorkshopBuild> {
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
    const built = await this.build(id);
    await this.serial(id, async () => {
      const card = await this.status(id);
      if (card.previousVersion && built.manifest?.version === card.previousVersion) {
        built.check.ok = false;
        built.check.errors.push('WORKSHOP_INVALID: an update must use a new package and module version');
      }
      if (!['draft', 'failed', 'cancelled'].includes(card.state)) return;
      if (built.check.ok) {
        const snapshot = `${built.directory}-source`;
        await cp(built.sourceDirectory, snapshot, { recursive: true });
        built.sourceDirectory = snapshot;
        await writeFile(join(this.store.directory(card.id), 'candidate.json'), JSON.stringify(built));
        await this.store.update(card.id, card.revision, {
          state: 'pending-confirmation',
          check: built.check,
          version: built.manifest?.version ?? null,
          error: null,
        });
      } else {
        await this.store.update(card.id, card.revision, {
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
      if (card.state !== 'installed') return null;
      await this.admin?.isolateManaged?.(card.pluginId);
      return this.store.update(id, card.revision, { state: 'failed', error, lastFault: error });
    });
    if (!failed) return this.status(id);
    // Never retry the same bad release. Recovery only runs an earlier approved source snapshot.
    if (failed.state === 'failed' && failed.previousVersion && failed.previousVersion !== failed.version) {
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
      const current = await this.expected(id, revision, ['draft', 'generating', 'failed', 'cancelled']);
      if (current.state === 'generating') this.jobs.get(id)?.abort();
      await writeSourceFiles(join(this.store.directory(id), 'source'), files);
      return this.store.update(id, revision, {
        state: current.state === 'generating' ? 'draft' : current.state,
        check: null,
        error: null,
      });
    });
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
      const active = (await owner.inventory()).plugins.find(item => item.id === card.pluginId);
      return this.store.update(id, revision, { state: 'installed', version: built.manifest.version, check: built.check, error: null,
        ...(active?.state === 'running' ? { usableVersion: built.manifest.version, lastGoodPackageDir: join(versionRoot, 'package') } : {}) });
    });
  }
  revoke(id: string, revision: number): Promise<WorkshopCard> {
    return this.serial(id, async () => {
      const card = await this.expected(id, revision, ['installed']);
      const owner = this.owner(), inventory = await owner.inventory();
      if (!inventory.revision) throw new Error('WORKSHOP_INSTALL_UNAVAILABLE: profile is read-only');
      await owner.uninstall(card.pluginId, inventory.revision);
      return this.store.update(id, revision, { state: 'revoked' });
    });
  }
  restore(id: string, revision: number): Promise<WorkshopCard> {
    return this.serial(id, async () => {
      const card = await this.expected(id, revision, ['revoked', 'failed', 'installed']);
      await this.assertExecutionAllowed();
      const retainedVersion = card.state === 'revoked' ? card.usableVersion ?? card.version : card.previousVersion ?? card.usableVersion;
      if (!retainedVersion) throw new Error('WORKSHOP_STATE: no successful version retained');
      const owner = this.owner(), inventory = await owner.inventory();
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
      return this.store.update(id, revision, { state: 'installed', version: retainedVersion, check: built.check, error: null, rollback: 'restored',
        ...(owner.activateManaged ? { usableVersion: retainedVersion, lastGoodPackageDir: join(versionRoot, 'package') } : {}) });
    });
  }
  async export(id: string): Promise<WorkshopExport> {
    const built = await this.build(id);
    if (!built.check.ok || !built.manifest) throw new Error(`WORKSHOP_INVALID: ${built.check.errors.join('\n')}`);
    const archive = new JSZip();
    for (const file of await sourceFiles(built.directory)) archive.file(file.replaceAll('\\', '/'), await readFile(join(built.directory, file)));
    const path = join(this.store.directory(id), 'exports', `${built.manifest.id}-${built.manifest.version}.dstuplugin`);
    await writeFile(path, await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    return { id, version: built.manifest.version, path };
  }
}
