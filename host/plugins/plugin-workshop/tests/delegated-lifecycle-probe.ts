import { mkdtemp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HostRuntime } from '../../../kernel/runtime.ts';
import { ContractSet } from '../../../kernel/contract-set.ts';
import { PluginAdmin } from '../../../kernel/plugin-admin.ts';
import { UserProfileStore } from '../../../kernel/profile-store.ts';
import { CommunityConsentLedger } from '../../../kernel/community-consent.ts';
import { PluginPackages } from '../../../kernel/plugin-packages/index.ts';
import { createNodeFiles } from '../../../platform/files/index.ts';
import { pluginServiceName } from '../../../kernel/plugin-id.ts';
import { WorkshopOperations } from '../src/operations.ts';
import { seedTemplate } from '../src/resources.ts';
import type { WorkshopCard, WorkshopVerificationResult } from '../api.ts';
import { injectedInstaller } from './installer-fixture.ts';

const brief = { sessionId: 'test', title: 'Recall', description: 'Recall each supplied word', template: 'host-tool' as const, changes: ['Each word receives a Recall prompt'], capabilities: [] };
const gate = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
async function fixture() {
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'dstu-delegated-')));
  await mkdir(join(dataDir, 'plugins'));
  const official = join(dataDir, 'official.json'); await writeFile(official, '{"plugins":[]}');
  const app = { dataDir, version: '0.20.0', platform: 'darwin' as const, debug: true };
  const files = createNodeFiles({ roots: [{ name: 'appData', path: dataDir }] });
  const runtime = new HostRuntime({ app, contracts: new ContractSet([]) });
  const packages = new PluginPackages(files.scope(join(dataDir, 'plugins')));
  new PluginAdmin({ runtime, store: new UserProfileStore(join(dataDir, 'plugins/user.profile.json'), official), official, consent: new CommunityConsentLedger(dataDir), files, packages }).register();
  const installer = await injectedInstaller(runtime);
  const ops = new WorkshopOperations(app); ops.bindAdmin(installer); await ops.ready();
  const verify = async (card: WorkshopCard): Promise<WorkshopVerificationResult> => {
    const record = (await installer.inventory()).plugins.find(item => item.id === card.pluginId);
    assert.equal(record?.version, card.validation?.version); assert.equal(record?.state, 'running');
    const service = runtime.ctx.get(pluginServiceName(card.pluginId)) as { review(words: string[]): unknown };
    assert.deepEqual(service.review(['orbit']), [{ word: 'orbit', prompt: 'Recall: orbit' }]);
    return { status: 'passed', evidence: ['Activated candidate review([orbit]) returned Recall: orbit'] };
  };
  const generate = async (card: WorkshopCard, source: string) => { if (!(await readdir(source)).length) await seedTemplate(source, card); };
  return { app, runtime, installer, packages, ops, verify, generate };
}
async function waitFor(predicate: () => boolean | Promise<boolean>, diagnostic: () => Promise<unknown>) {
  const deadline = Date.now() + 10_000;
  while (!await predicate()) {
    assert(Date.now() < deadline, JSON.stringify(await diagnostic()));
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function settled(ops: WorkshopOperations, id: string, stage: string) {
  await waitFor(async () => (await ops.status(id)).execution?.stage === stage, () => ops.status(id));
  return ops.status(id);
}

await test('runs a delegated request through actual activation and behavior, recovers a failed candidate, and ignores its late pass/error', async () => {
  const f = await fixture(); const { ops } = f;
  const late = gate<WorkshopVerificationResult>(), repaired = gate<void>();
  const inputs: WorkshopCard[] = []; let checking = false;
  let preview: { id: string; pluginId: string; version: string; revision: number } | undefined;
  ops.bindCandidatePreview(async candidate => {
    const current = await ops.status(candidate.id);
    assert.equal(current.state, 'installed'); assert.equal(current.validation?.status, 'pending');
    assert.equal(candidate.version, current.validation.version); assert.equal(candidate.revision, current.validation.revision);
    preview = candidate;
  });
  ops.bindGeneration({ generate: async (card, source) => {
    inputs.push(card); await f.generate(card, source);
    if (card.error) {
      const running = (await f.installer.inventory()).plugins.find(item => item.id === card.pluginId);
      assert.equal(running?.state, 'running'); assert.equal(running?.version, '1.0.0');
      assert.match(await readFile(join(source, 'index.ts'), 'utf8'), /failed-candidate-source/);
      await repaired.promise;
    } else if (inputs.length === 2) await writeFile(join(source, 'index.ts'), `${await readFile(join(source, 'index.ts'), 'utf8')}\n// failed-candidate-source\n`);
  }, verify: async card => {
    assert.deepEqual(preview, { id: card.id, pluginId: card.pluginId, version: card.validation?.version, revision: card.validation?.revision });
    await f.verify(card);
    if (card.validation?.version === '1.0.1') { checking = true; return late.promise; }
    return f.verify(card);
  } });
  try {
    let card = await ops.propose(brief); await ops.delegate(card.id, card.revision, { modelId: 'selected-model' });
    card = await settled(ops, card.id, 'complete');
    assert.equal(card.usableVersion, '1.0.0'); assert.equal(card.execution?.modelId, 'selected-model');
    card = await ops.propose({ ...brief, pluginId: card.pluginId }); await ops.delegate(card.id, card.revision);
    await waitFor(() => checking, () => ops.status(card.id));
    card = await ops.status(card.id);
    assert.equal(card.usableVersion, '1.0.0'); assert.equal(card.validation?.status, 'pending'); assert.equal(card.validation?.version, '1.0.1');
    await assert.rejects(ops.reportValidation(card.id, '1.0.1', card.validation!.revision, { ok: true }), /WORKSHOP_VERIFICATION_REQUIRED/);
    await ops.reportValidation(card.id, '1.0.1', card.validation!.revision, { ok: false, detail: 'Actual UI failed' });
    await waitFor(() => inputs.length === 3, () => ops.status(card.id));
    late.resolve({ status: 'passed', evidence: ['late obsolete pass'] });
    assert.equal((await ops.status(card.id)).usableVersion, '1.0.0');
    repaired.resolve();
    const complete = await settled(ops, card.id, 'complete');
    assert.equal(complete.usableVersion, '1.0.2'); assert.equal(complete.validation?.status, 'passed'); assert.equal(complete.validation?.version, '1.0.2');
    await ops.reportFault(card.id, 'late old iframe error', '1.0.1');
    await ops.reportValidation(card.id, '1.0.1', card.validation!.revision, { ok: false, detail: 'duplicate' });
    assert.equal((await ops.status(card.id)).revision, complete.revision);
    assert.equal((await f.packages.verify(card.pluginId)).version, '1.0.2');
  } finally { late.resolve({ status: 'blocked', evidence: [] }); repaired.resolve(); ops.dispose(); await f.runtime.dispose(); }
});

await test('resumes a persisted delegated generation and does not resume cancellation or accept a late verifier pass', async () => {
  const f = await fixture(); const old = gate<void>(), verifying = gate<WorkshopVerificationResult>();
  let ops = f.ops; let verifyingStarted = false;
  ops.bindGeneration({ generate: async () => old.promise });
  try {
    let card = await ops.propose(brief); await ops.delegate(card.id, card.revision); ops.dispose(); old.resolve();
    ops = new WorkshopOperations(f.app); ops.bindAdmin(f.installer); await ops.ready();
    ops.bindGeneration({ generate: f.generate, verify: async card => { await f.verify(card); verifyingStarted = true; return verifying.promise; } });
    await ops.resumeDelegated();
    await waitFor(() => verifyingStarted, () => ops.status(card.id));
    card = await ops.status(card.id); assert.equal(card.usableVersion, null);
    card = await ops.cancel(card.id, card.revision); assert.equal(card.state, 'cancelled');
    verifying.resolve({ status: 'passed', evidence: ['late after cancellation'] });
    await ops.resumeDelegated();
    card = await ops.status(card.id); assert.equal(card.state, 'cancelled'); assert.equal(card.execution, null);
    assert.equal(card.usableVersion, null); assert.equal(card.installation?.state, 'failed');
    assert.equal((await f.installer.inventory()).plugins.find(item => item.id === card.pluginId)?.enabled, false);
  } finally { old.resolve(); verifying.resolve({ status: 'blocked', evidence: [] }); ops.dispose(); await f.runtime.dispose(); }
});

await test('manual activation stays unverified until behavior evidence and a blocked verifier permits a new change', async () => {
  const f = await fixture(); const { ops } = f; let checks = 0;
  ops.bindGeneration({ generate: f.generate, verify: async card => { checks++; await f.verify(card); return { status: 'blocked', evidence: [], error: 'Acceptance needs user-only information' }; } });
  try {
    let card = await ops.propose(brief); await ops.create(card.id, card.revision);
    await waitFor(async () => (await ops.status(card.id)).state === 'pending-confirmation', () => ops.status(card.id));
    card = await ops.status(card.id); card = await ops.install(card.id, card.revision);
    assert.equal(card.usableVersion, null); assert.equal(card.validation?.status, 'pending');
    await waitFor(async () => (await ops.status(card.id)).error?.includes('user-only') === true, () => ops.status(card.id));
    const revised = await ops.propose({ ...brief, pluginId: card.pluginId });
    assert.equal(revised.installation?.version, '1.0.0'); assert.equal(revised.usableVersion, null); assert.equal(checks, 1);
    await ops.create(revised.id, revised.revision);
    await waitFor(async () => (await ops.status(card.id)).state === 'pending-confirmation', () => ops.status(card.id));
    assert.equal((await ops.status(card.id)).version, '1.0.1');
    assert.equal((await f.packages.verify(card.pluginId)).version, '1.0.0');
  } finally { ops.dispose(); await f.runtime.dispose(); }
});

await test('an activation-only failure restores the verified version and repairs in the same delegated task', async () => {
  const f = await fixture(); const { ops } = f;
  let repaired = false;
  ops.bindAdmin({ ...f.installer, async activateManaged(id, revision) {
    // Inject only while the real installed package activates; compile/lifecycle checks see the normal environment.
    (globalThis as Record<string, unknown>).__workshopActivationOnlyFailure = true;
    try { return await f.installer.activateManaged(id, revision); }
    finally { (globalThis as Record<string, unknown>).__workshopActivationOnlyFailure = undefined; }
  } });
  ops.bindGeneration({ generate: async (card, source) => {
    await f.generate(card, source);
    if (card.error) {
      assert.match(card.error, /actual-activation-failed/);
      assert.equal((await f.installer.inventory()).plugins.find(item => item.id === card.pluginId)?.version, '1.0.0');
      repaired = true;
      const code = await readFile(join(source, 'index.ts'), 'utf8');
      await writeFile(join(source, 'index.ts'), code.replace("if (globalThis.__workshopActivationOnlyFailure) throw new Error('actual-activation-failed'); ", ''));
    } else if (card.previousVersion) {
      const code = await readFile(join(source, 'index.ts'), 'utf8');
      await writeFile(join(source, 'index.ts'), code.replace('ctx.provide(', "if (globalThis.__workshopActivationOnlyFailure) throw new Error('actual-activation-failed'); ctx.provide("));
    }
  }, verify: f.verify });
  try {
    let card = await ops.propose(brief); await ops.delegate(card.id, card.revision); card = await settled(ops, card.id, 'complete');
    card = await ops.propose({ ...brief, pluginId: card.pluginId }); await ops.delegate(card.id, card.revision);
    card = await settled(ops, card.id, 'complete');
    assert.equal(repaired, true); assert.equal(card.usableVersion, '1.0.2');
    assert.equal((await f.packages.verify(card.pluginId)).version, '1.0.2');
  } finally { (globalThis as Record<string, unknown>).__workshopActivationOnlyFailure = undefined; ops.dispose(); await f.runtime.dispose(); }
});

await test('resumes pending verification, then resumes a durable rollback before the repair task was started', async () => {
  const f = await fixture(); let ops = f.ops;
  const interrupted = gate<WorkshopVerificationResult>(); let verifying = false;
  try {
    ops.bindGeneration({ generate: f.generate, verify: f.verify });
    let card = await ops.propose(brief); await ops.delegate(card.id, card.revision); card = await settled(ops, card.id, 'complete');
    ops.bindGeneration({ generate: f.generate, verify: async () => { verifying = true; return interrupted.promise; } });
    card = await ops.propose({ ...brief, pluginId: card.pluginId }); await ops.delegate(card.id, card.revision);
    await waitFor(() => verifying, () => ops.status(card.id));
    const validationRevision = (await ops.status(card.id)).validation!.revision;
    ops.dispose();
    ops = new WorkshopOperations(f.app); ops.bindAdmin(f.installer); await ops.ready();
    ops.bindGeneration({ generate: f.generate, verify: f.verify }); await ops.resumeDelegated();
    card = await settled(ops, card.id, 'complete');
    assert(card.validation!.revision > validationRevision); assert.equal(card.usableVersion, '1.0.1');
    interrupted.resolve({ status: 'failed', evidence: [], error: 'late pre-restart failure' });
    ops.dispose();
    // Startup can recover before the generation dependency is bound. Recovery remains resumable on disk.
    ops = new WorkshopOperations(f.app); ops.bindAdmin(f.installer); await ops.ready();
    card = await ops.reportFault(card.id, 'Failure after successful validation', '1.0.1');
    assert.equal(card.execution?.stage, 'repairing'); assert.equal(card.installation?.version, '1.0.0');
    assert.equal(card.usableVersion, '1.0.0'); // Recovery restores the older verified release, never the faulty one.
    assert.equal(card.verifiedVersions?.['1.0.1'], undefined);
    ops.dispose();
    ops = new WorkshopOperations(f.app); ops.bindAdmin(f.installer); await ops.ready();
    ops.bindGeneration({ generate: async (work, source) => { assert.match(work.error ?? '', /Failure after/); await f.generate(work, source); }, verify: f.verify });
    await ops.resumeDelegated(); card = await settled(ops, card.id, 'complete');
    assert.equal(card.usableVersion, '1.0.2');
  } finally { interrupted.resolve({ status: 'blocked', evidence: [] }); ops.dispose(); await f.runtime.dispose(); }
});

await test('manual rollback restores persisted verification and the next edit starts from the running old source', async () => {
  const f = await fixture(); let ops = f.ops; let generation = 0;
  const generate = async (card: WorkshopCard, source: string) => {
    generation++;
    await f.generate(card, source);
    const path = join(source, 'index.ts');
    if (generation === 2) await writeFile(path, (await readFile(path, 'utf8')).replace('Recall: ${word}', 'Revision2: ${word}'));
    if (generation === 3) {
      const inherited = await readFile(path, 'utf8');
      assert(inherited.includes('Recall: ${word}')); assert(!inherited.includes('Revision2: ${word}'));
    }
  };
  const verify = async (card: WorkshopCard): Promise<WorkshopVerificationResult> => {
    const running = (await f.installer.inventory()).plugins.find(item => item.id === card.pluginId);
    assert.equal(running?.state, 'running'); assert.equal(running?.version, card.validation?.version);
    const service = f.runtime.ctx.get(pluginServiceName(card.pluginId)) as { review(words: string[]): unknown };
    const expected = card.version === '1.0.1' ? 'Revision2: orbit' : 'Recall: orbit';
    assert.deepEqual(service.review(['orbit']), [{ word: 'orbit', prompt: expected }]);
    return { status: 'passed', evidence: [`Actual service returned ${expected}`] };
  };
  try {
    ops.bindGeneration({ generate, verify });
    let card = await ops.propose(brief); await ops.delegate(card.id, card.revision); card = await settled(ops, card.id, 'complete');
    const firstValidation = card.validation;
    card = await ops.propose({ ...brief, pluginId: card.pluginId }); await ops.delegate(card.id, card.revision); card = await settled(ops, card.id, 'complete');
    assert.equal(card.usableVersion, '1.0.1');
    ops.dispose(); ops = new WorkshopOperations(f.app); ops.bindAdmin(f.installer); await ops.ready();
    card = await ops.restore(card.id, card.revision);
    assert.equal(card.version, '1.0.0'); assert.equal(card.installation?.version, '1.0.0');
    assert.equal(card.usableVersion, '1.0.0'); assert.equal(card.previousVersion, null);
    assert.equal(card.installation.previousVersion, null); assert.deepEqual(card.validation, firstValidation);
    assert.equal(card.lastGoodPackageDir, join(ops.store.directory(card.id), 'versions/1.0.0/package'));
    await verify(card);
    // The repaired pointers must survive another process lifetime, including uninstall/reinstall recovery.
    ops.dispose(); ops = new WorkshopOperations(f.app); ops.bindAdmin(f.installer); await ops.ready();
    card = await ops.status(card.id); card = await ops.revoke(card.id, card.revision); card = await ops.restore(card.id, card.revision);
    assert.equal(card.usableVersion, '1.0.0'); await verify(card);
    ops.bindGeneration({ generate, verify });
    card = await ops.propose({ ...brief, pluginId: card.pluginId }); await ops.delegate(card.id, card.revision);
    card = await settled(ops, card.id, 'complete');
    assert.equal(card.usableVersion, '1.0.2'); assert.equal(card.installation?.previousVersion, '1.0.0');
  } finally { ops.dispose(); await f.runtime.dispose(); }
});

await test('restoring an unverified predecessor clears newer recovery pointers without certifying the old release', async () => {
  const f = await fixture(); const { ops } = f;
  try {
    ops.bindGeneration({ generate: f.generate, verify: async () => ({ status: 'blocked', evidence: [], error: 'Manual acceptance still needed' }) });
    let card = await ops.propose(brief); await ops.delegate(card.id, card.revision); card = await settled(ops, card.id, 'blocked');
    ops.bindGeneration({ generate: f.generate, verify: f.verify });
    card = await ops.propose({ ...brief, pluginId: card.pluginId }); await ops.delegate(card.id, card.revision); card = await settled(ops, card.id, 'complete');
    assert.equal(card.usableVersion, '1.0.1');
    card = await ops.restore(card.id, card.revision);
    assert.equal(card.installation?.version, '1.0.0'); assert.equal(card.usableVersion, null);
    assert.equal(card.lastGoodPackageDir, null); assert.equal(card.validation, null); assert.equal(card.execution, null);
    const service = f.runtime.ctx.get(pluginServiceName(card.pluginId)) as { review(words: string[]): unknown };
    assert.deepEqual(service.review(['orbit']), [{ word: 'orbit', prompt: 'Recall: orbit' }]);
  } finally { ops.dispose(); await f.runtime.dispose(); }
});

for (const interruptFinalWrite of [false, true]) {
  await test(interruptFinalWrite ? 'reconciles a rollback interrupted after activating its retained release'
    : 'manual rollback aborts validation and ignores a late blocked result', async () => {
    const f = await fixture(); let ops = f.ops; let generations = 0;
    const late = gate<WorkshopVerificationResult>();
    let oldSignal: AbortSignal | undefined;
    const generate = async (work: WorkshopCard, source: string) => {
      await f.generate(work, source);
      const path = join(source, 'index.ts');
      const text = await readFile(path, 'utf8');
      if (++generations === 2) await writeFile(path, text.replace('Recall: ${word}', 'Withdrawn: ${word}'));
      if (generations === 3) assert.match(text, /Recall: \$\{word\}/);
    };
    try {
      ops.bindGeneration({ generate, verify: f.verify });
      let card = await ops.propose(brief); await ops.delegate(card.id, card.revision); card = await settled(ops, card.id, 'complete');
      const previousValidation = card.validation;
      ops.bindGeneration({ generate, verify: async (work, _source, signal) => {
        if (!interruptFinalWrite) { oldSignal = signal; return late.promise; }
        const service = f.runtime.ctx.get(pluginServiceName(work.pluginId)) as { review(words: string[]): unknown };
        assert.deepEqual(service.review(['orbit']), [{ word: 'orbit', prompt: 'Withdrawn: orbit' }]);
        return { status: 'passed', evidence: ['Actual service returned Withdrawn: orbit'] };
      } });
      card = await ops.propose({ ...brief, pluginId: card.pluginId }); await ops.delegate(card.id, card.revision);
      if (interruptFinalWrite) {
        card = await settled(ops, card.id, 'complete');
        const update = ops.store.update.bind(ops.store);
        ops.store.update = (id, revision, patch) => {
          if (patch.rollback === 'restored') return Promise.reject(new Error('interrupted final rollback write'));
          return update(id, revision, patch);
        };
        await assert.rejects(ops.restore(card.id, card.revision), /interrupted final rollback write/);
        card = await ops.status(card.id);
        assert.equal(card.pendingRestore?.version, '1.0.0'); assert.equal(card.usableVersion, '1.0.1');
        assert.equal((await f.installer.inventory()).plugins.find(item => item.id === card.pluginId)?.version, '1.0.0');
      } else {
        await waitFor(() => Boolean(oldSignal), () => ops.status(card.id));
        card = await ops.status(card.id); card = await ops.restore(card.id, card.revision);
        assert.equal(oldSignal?.aborted, true); assert.equal(card.execution, null);
        late.resolve({ status: 'blocked', evidence: [], error: 'Withdrawn verification came back late' });
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(await ops.status(card.id), card);
      }
      ops.dispose(); ops = new WorkshopOperations(f.app); ops.bindAdmin(f.installer); await ops.ready();
      ops.bindGeneration({ generate, verify: f.verify }); await ops.resumeDelegated();
      card = await ops.status(card.id);
      assert.equal(card.pendingRestore, null); assert.equal(card.execution, null);
      assert.equal(card.version, '1.0.0'); assert.equal(card.installation?.version, '1.0.0'); assert.equal(card.usableVersion, '1.0.0');
      assert.equal(card.lastGoodPackageDir, join(ops.store.directory(card.id), 'versions/1.0.0/package'));
      assert.deepEqual(card.validation, previousValidation); await f.verify(card);
      card = await ops.propose({ ...brief, pluginId: card.pluginId }); await ops.delegate(card.id, card.revision);
      card = await settled(ops, card.id, 'complete');
      assert.equal(card.version, '1.0.2'); assert.equal(card.installation?.previousVersion, '1.0.0');
    } finally { late.resolve({ status: 'blocked', evidence: [] }); ops.dispose(); await f.runtime.dispose(); }
  });
}

await test('startup finishes isolation when cancellation was persisted before candidate cleanup', async () => {
  const f = await fixture(); let ops = f.ops;
  const interrupted = gate<WorkshopVerificationResult>(); let verifying = false;
  try {
    ops.bindGeneration({ generate: f.generate, verify: async card => { await f.verify(card); verifying = true; return interrupted.promise; } });
    let card = await ops.propose(brief); await ops.delegate(card.id, card.revision);
    await waitFor(() => verifying, () => ops.status(card.id));
    card = await ops.status(card.id); ops.dispose();
    await ops.store.update(card.id, card.revision, { state: 'cancelled', execution: null });
    ops = new WorkshopOperations(f.app); ops.bindAdmin(f.installer); await ops.ready(); await ops.resumeDelegated();
    card = await ops.status(card.id); assert.equal(card.state, 'cancelled'); assert.equal(card.installation?.state, 'failed');
    assert.equal(card.usableVersion, null); assert.equal((await f.installer.inventory()).plugins.find(item => item.id === card.pluginId)?.enabled, false);
  } finally { interrupted.resolve({ status: 'passed', evidence: ['late'] }); ops.dispose(); await f.runtime.dispose(); }
});

await test('retrying a blocked candidate keeps its installation, reapplies settings and rejects the old attempt', async () => {
  const f = await fixture(); const { ops } = f; let generations = 0, checks = 0;
  const finish = gate<void>();
  ops.bindGeneration({ generate: async (card, source) => { generations++; await f.generate(card, source); }, verify: async card => {
    await f.verify(card); checks++;
    if (checks === 1) return { status: 'blocked', evidence: [], error: 'Acceptance prerequisite unavailable' };
    assert.equal(((await f.installer.configOf(card.pluginId)).values as Record<string, unknown>)?.label, 'new');
    await finish.promise;
    return f.verify(card);
  } });
  try {
    let card = await ops.propose({ ...brief, settings: [{ key: 'label', title: 'Label', kind: 'text', value: 'old' }] });
    await ops.delegate(card.id, card.revision); card = await settled(ops, card.id, 'blocked');
    const attempt = card.validation!.revision; const version = card.validation!.version;
    assert.equal(card.state, 'installed'); assert.equal(card.usableVersion, null);
    const retry = await ops.create(card.id, card.revision, { label: 'new' });
    assert(retry.validation!.revision > attempt);
    await waitFor(() => checks === 2, () => ops.status(card.id));
    const retryOnDisk = await ops.status(card.id);
    const afterLateReport = await ops.reportValidation(card.id, version, attempt, { ok: false, detail: 'Prior window failure' });
    assert.deepEqual(afterLateReport, retryOnDisk);
    finish.resolve(); card = await settled(ops, card.id, 'complete');
    assert.equal(card.validation?.revision, retry.validation?.revision); assert.equal(card.validation?.version, version);
    assert.equal(card.usableVersion, version); assert.equal(generations, 1); assert.equal(checks, 2);
  } finally { finish.resolve(); ops.dispose(); await f.runtime.dispose(); }
});

await test('delegated generation uses explicit blockedReason instead of the legacy error keyword stop', async () => {
  const f = await fixture(); const { ops } = f; let generations = 0;
  ops.bindGeneration({ generate: async card => {
    generations++;
    if (!card.error) throw new Error('WORKSHOP_UNAVAILABLE: missing provider response');
    assert.match(card.error, /missing provider response/);
    return { blockedReason: 'Provider needs reconnection before this request can continue' };
  }, verify: f.verify });
  try {
    let card = await ops.propose(brief); await ops.delegate(card.id, card.revision); card = await settled(ops, card.id, 'blocked');
    assert.equal(generations, 2); assert.equal(card.state, 'failed'); assert.match(card.execution?.reason ?? '', /needs reconnection/);
    assert.equal((await f.installer.inventory()).plugins.some(item => item.id === card.pluginId), false);
  } finally { ops.dispose(); await f.runtime.dispose(); }
});
