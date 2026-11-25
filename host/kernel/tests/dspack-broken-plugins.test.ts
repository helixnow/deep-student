import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PLUGIN_MANAGER_CONSENT_COMMAND,
  PLUGIN_MANAGER_INSTALL_COMMAND,
  PLUGIN_MANAGER_LIST_COMMAND,
  PLUGIN_MANAGER_SET_ENABLED_COMMAND,
  PLUGIN_MANAGER_UNINSTALL_COMMAND,
  type PluginManagerInstallResult,
  type WindowRef,
} from '../api.ts';
import { CommunityConsentLedger } from '../community-consent.ts';
import { ContractSet } from '../contracts.ts';
import {
  PLUGIN_MANAGER_DECLARATIVE_SKILLS_COMMAND,
  PluginAdmin,
  consentProblem,
  type PluginManagerInventoryWithStatus,
} from '../plugin-admin.ts';
import type { DeclarativeSkillAsset } from '../declarative-registry.ts';
import { PluginPackages } from '../plugin-packages/index.ts';
import { loadStartupProfile } from '../profile.ts';
import { UserProfileStore } from '../profile-store.ts';
import { HostRuntime } from '../runtime.ts';
import { createNodeFiles } from '../../platform/files/index.ts';
import { GradingRubricRegistry } from '../../plugins/llm/src/essay_grading/rubric-registry.ts';
import { createStudyPackArchive } from '../../plugins/plugin-workshop/src/study-pack.ts';

const FIXTURES = fileURLToPath(new URL('../__fixtures__/', import.meta.url));
const LOCAL: WindowRef = { window: 'main', webview: 'main' };
const enc = new TextEncoder();

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dstu-dspack-broken-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeOfficialProfile(dir: string): Promise<string> {
  const path = join(dir, 'official.profile.json');
  await writeFile(path, JSON.stringify({
    plugins: [{ id: 'dstu.plain', module: join(FIXTURES, 'manager-plain.plugin.ts') }],
  }));
  return path;
}

async function createSampleStudyPackArchive(targetPath: string, id = 'alice.kaoyan-pack'): Promise<void> {
  const pkg = {
    name: `deepstudent-pack-${id.replace(/\./g, '-')}`,
    version: '1.0.0',
    engines: { deepStudent: '^0.20', deepStudentPluginApi: '2' },
    deepStudent: {
      manifestVersion: 2,
      id,
      kind: 'study-pack',
      displayName: '考研数学证明冲刺包',
      author: 'Alice',
      platforms: ['desktop', 'mobile'],
      declarative: {
        rubrics: ['./rubrics/kaoyan-math.yaml'],
        skills: ['./skills/kaoyan-coach.md'],
        cardTemplates: ['./templates/proof-cloze.yaml'],
        workflows: ['./workflows/sprint.yaml'],
      },
    },
  };
  const rubricYaml = `
id: kaoyan-math-proof
name: 考研数学证明题严格批改
description: 按逻辑严密性与步骤完整度打分
systemPrompt: 请逐步骤核查证明严密性。
scoreDimensions:
  - name: 逻辑严密性
    maxScore: 10
totalMaxScore: 10
`;
  const skillMarkdown = `---
id: kaoyan-coach
name: 考研数学证明教练
description: 先引导学习者列出已知条件与待证目标
---
# 考研数学证明教练
先让学习者写出定理前提条件，再逐步引导。
`;
  const cardTemplateYaml = `
id: proof-cloze
name: 证明关键步挖空卡
frontTemplate: "定理：{{theorem}}"
backTemplate: "证明：{{proof}}"
fields: [theorem, proof]
`;
  const workflowYaml = `
id: kaoyan-sprint
name: 考研数学闭环冲刺
trigger: /kaoyan-sprint
steps:
  - id: diagnose
    title: 诊断错题
    prompt: 汇总近 7 天证明错题
`;
  const bytes = await createStudyPackArchive([
    { path: 'package.json', bytes: enc.encode(`${JSON.stringify(pkg, null, 2)}\n`) },
    { path: 'rubrics/kaoyan-math.yaml', bytes: enc.encode(rubricYaml) },
    { path: 'skills/kaoyan-coach.md', bytes: enc.encode(skillMarkdown) },
    { path: 'templates/proof-cloze.yaml', bytes: enc.encode(cardTemplateYaml) },
    { path: 'workflows/sprint.yaml', bytes: enc.encode(workflowYaml) },
  ]);
  await writeFile(targetPath, bytes);
}

async function createHost(dataDir: string, officialProfile: string, options: { safeMode?: boolean } = {}) {
  await mkdir(join(dataDir, 'plugins'), { recursive: true });
  const runtime = new HostRuntime({
    app: { dataDir, version: '0.20.9', platform: 'linux', debug: true },
    contracts: ContractSet.empty(),
    safeMode: options.safeMode === true,
  });
  runtime.ctx.provide('paths', {});
  runtime.ctx.provide('storage', {});
  runtime.ctx.provide('log', {});
  const rubrics = new GradingRubricRegistry();
  runtime.ctx.provide('gradingRubrics', rubrics);
  const userProfile = join(dataDir, 'plugins', 'user.profile.json');
  const store = new UserProfileStore(userProfile, officialProfile);
  const consent = new CommunityConsentLedger(dataDir);
  const files = createNodeFiles({ roots: [{ name: 'appData', path: dataDir }, { name: 'temp', path: root }] });
  const packages = new PluginPackages(files.scope(join(dataDir, 'plugins')));
  const admin = new PluginAdmin({ runtime, store, official: officialProfile, consent, files, packages });
  admin.register();
  return { runtime, store, consent, packages, rubrics, userProfile };
}

async function callOk<T>(runtime: HostRuntime, cmd: string, args: unknown = {}, source: WindowRef = LOCAL): Promise<T> {
  const outcome = await runtime.dispatchInvoke({ id: `inv-${cmd}-${Math.random()}`, cmd, args, source });
  if (outcome.kind !== 'ok') throw new Error(`expected ok from ${cmd}: ${JSON.stringify(outcome)}`);
  return outcome.value as T;
}

async function callErr(runtime: HostRuntime, cmd: string, args: unknown = {}, source: WindowRef = LOCAL): Promise<string> {
  const outcome = await runtime.dispatchInvoke({ id: `inv-${cmd}-${Math.random()}`, cmd, args, source });
  if (outcome.kind !== 'err') throw new Error(`expected err from ${cmd}: ${JSON.stringify(outcome)}`);
  return JSON.stringify(outcome.error);
}

describe('G02: declarative .dspack enablement, summary, skills IPC, and reload persistence', () => {
  it('installs, consents, enables through symlinked dataDir, exposes declarative summary & skills IPC, and survives reload', async () => {
    const realDataDir = join(root, 'real-data');
    const symlinkDataDir = join(root, 'linked-data');
    await mkdir(realDataDir, { recursive: true });
    await symlink(realDataDir, symlinkDataDir);

    const officialProfile = await writeOfficialProfile(root);
    const archivePath = join(root, 'kaoyan-v1.0.0.dspack');
    await createSampleStudyPackArchive(archivePath);

    const host = await createHost(symlinkDataDir, officialProfile);
    try {
      await loadStartupProfile(host.runtime, { official: officialProfile, userProfile: host.userProfile });
      const initial = await callOk<PluginManagerInventoryWithStatus>(host.runtime, PLUGIN_MANAGER_LIST_COMMAND);

      const installed = await callOk<PluginManagerInstallResult>(host.runtime, PLUGIN_MANAGER_INSTALL_COMMAND, {
        path: archivePath,
        revision: initial.revision,
      });
      expect(installed.id).toBe('alice.kaoyan-pack');
      expect(installed.enabled).toBe(false);

      // Stopped .dspack already reports kind, tier, declarative paths, and declarative contributes tags.
      const beforeEnable = (await callOk<PluginManagerInventoryWithStatus>(host.runtime, PLUGIN_MANAGER_LIST_COMMAND))
        .plugins.find((entry) => entry.id === 'alice.kaoyan-pack');
      expect(beforeEnable).toMatchObject({
        id: 'alice.kaoyan-pack',
        kind: 'study-pack',
        tier: 'declarative',
        state: 'disabled',
        declarative: {
          skills: ['./skills/kaoyan-coach.md'],
          rubrics: ['./rubrics/kaoyan-math.yaml'],
          cardTemplates: ['./templates/proof-cloze.yaml'],
          workflows: ['./workflows/sprint.yaml'],
        },
      });
      expect(beforeEnable?.contributes).toEqual(expect.arrayContaining([
        'declarative.skills',
        'declarative.rubrics',
        'declarative.cardTemplates',
        'declarative.workflows',
      ]));

      // Grant consent + enable (must not fail with PLUGIN_NOT_FOUND or HOST_ENTRY_MISMATCH under symlinked dataDir).
      await callOk(host.runtime, PLUGIN_MANAGER_CONSENT_COMMAND, {
        id: 'alice.kaoyan-pack',
        version: '1.0.0',
        permissions: [],
      });
      const enabled = await callOk<{ enabled: boolean; revision: string }>(
        host.runtime,
        PLUGIN_MANAGER_SET_ENABLED_COMMAND,
        { id: 'alice.kaoyan-pack', enabled: true, revision: installed.revision },
      );
      expect(enabled.enabled).toBe(true);
      expect(host.runtime.get('alice.kaoyan-pack')).toBeDefined();

      // Running .dspack reports mounted human-readable names in `declarative`.
      const afterEnable = (await callOk<PluginManagerInventoryWithStatus>(host.runtime, PLUGIN_MANAGER_LIST_COMMAND))
        .plugins.find((entry) => entry.id === 'alice.kaoyan-pack');
      expect(afterEnable).toMatchObject({
        state: 'running',
        enabled: true,
        kind: 'study-pack',
        tier: 'declarative',
        declarative: {
          skills: ['考研数学证明教练'],
          rubrics: ['考研数学证明题严格批改'],
          cardTemplates: ['证明关键步挖空卡'],
          workflows: ['考研数学闭环冲刺'],
        },
      });

      // Read-only kernel command exposes mounted declarative skills for frontend Skills loader.
      const skills = await callOk<DeclarativeSkillAsset[]>(host.runtime, PLUGIN_MANAGER_DECLARATIVE_SKILLS_COMMAND);
      expect(skills).toHaveLength(1);
      expect(skills[0]).toMatchObject({
        pluginId: 'alice.kaoyan-pack',
        skillId: 'kaoyan-coach',
        name: '考研数学证明教练',
        sourcePath: './skills/kaoyan-coach.md',
      });
      // Untrusted source & unexpected args are rejected.
      expect(await callErr(host.runtime, PLUGIN_MANAGER_DECLARATIVE_SKILLS_COMMAND, {}, { window: 'other', webview: 'other' }))
        .toMatch(/PLUGIN_MANAGER_FORBIDDEN|not allowed by ACL/);
      expect(await callErr(host.runtime, PLUGIN_MANAGER_DECLARATIVE_SKILLS_COMMAND, { extra: true }))
        .toContain('takes no arguments');
    } finally {
      await host.runtime.dispose();
    }

    // Inject an unrelated broken entry in user.profile.json and simulate a cold restart / reload.
    const rawProfile = JSON.parse(await readFile(join(realDataDir, 'plugins', 'user.profile.json'), 'utf8')) as {
      extends?: string;
      plugins: Record<string, unknown>[];
    };
    rawProfile.plugins.push({ id: 'broken.invalid-entry' });
    await writeFile(join(realDataDir, 'plugins', 'user.profile.json'), JSON.stringify(rawProfile, null, 2));

    const restarted = await createHost(symlinkDataDir, officialProfile);
    try {
      await loadStartupProfile(restarted.runtime, {
        official: officialProfile,
        userProfile: restarted.userProfile,
        communityGate: async (manifest) => {
          const rec = (await restarted.packages.list()).find((entry) => entry.id === manifest.id);
          return consentProblem(restarted.consent, manifest, rec);
        },
      });
      // Consented .dspack survived reload even alongside an invalid user profile entry!
      expect(restarted.runtime.get('alice.kaoyan-pack')).toBeDefined();
      const reloadedSkills = await callOk<DeclarativeSkillAsset[]>(restarted.runtime, PLUGIN_MANAGER_DECLARATIVE_SKILLS_COMMAND);
      expect(reloadedSkills.map((s) => s.skillId)).toEqual(['kaoyan-coach']);
      expect(restarted.runtime.degradedPlugins()).toContainEqual(expect.objectContaining({ id: 'broken.invalid-entry' }));
    } finally {
      await restarted.runtime.dispose();
    }
  });

  it('recovers consent & enable from plugins.lock.json when user.profile.json is missing the entry, and surfaces real manifest errors instead of PLUGIN_NOT_FOUND', async () => {
    const dataDir = join(root, 'lock-fallback-data');
    const officialProfile = await writeOfficialProfile(root);
    const archivePath = join(root, 'pack.dspack');
    await createSampleStudyPackArchive(archivePath);

    const host = await createHost(dataDir, officialProfile);
    try {
      const initial = await callOk<PluginManagerInventoryWithStatus>(host.runtime, PLUGIN_MANAGER_LIST_COMMAND);
      await callOk<PluginManagerInstallResult>(host.runtime, PLUGIN_MANAGER_INSTALL_COMMAND, {
        path: archivePath,
        revision: initial.revision,
      });

      // Wipe user.profile.json plugins array while plugins.lock.json still holds the verified release.
      await writeFile(host.userProfile, JSON.stringify({ extends: 'official', plugins: [] }, null, 2));
      const listBeforeConsent = await callOk<PluginManagerInventoryWithStatus>(host.runtime, PLUGIN_MANAGER_LIST_COMMAND);
      expect(listBeforeConsent.plugins.some((p) => p.id === 'alice.kaoyan-pack')).toBe(true);

      await callOk(host.runtime, PLUGIN_MANAGER_CONSENT_COMMAND, {
        id: 'alice.kaoyan-pack',
        version: '1.0.0',
        permissions: [],
      });
      const enabled = await callOk<{ enabled: boolean; revision: string }>(
        host.runtime,
        PLUGIN_MANAGER_SET_ENABLED_COMMAND,
        { id: 'alice.kaoyan-pack', enabled: true, revision: listBeforeConsent.revision },
      );
      expect(enabled.enabled).toBe(true);
      expect(host.runtime.get('alice.kaoyan-pack')).toBeDefined();
      const persisted = JSON.parse(await readFile(host.userProfile, 'utf8')) as { plugins: Array<{ id: string }> };
      expect(persisted.plugins.some((p) => p.id === 'alice.kaoyan-pack')).toBe(true);

      // Broken plugin in profile must report MANIFEST_INVALID (not mask as PLUGIN_NOT_FOUND) on consent.
      const brokenDir = join(dataDir, 'plugins', 'broken.bad-json');
      await mkdir(brokenDir, { recursive: true });
      await writeFile(join(brokenDir, 'package.json'), '{ invalid json', 'utf8');
      const rev = (await host.store.read()).revision;
      await host.store.mutate(rev, (file) => {
        file.plugins.push({ id: 'broken.bad-json', module: './broken.bad-json/package.json' });
      });
      const consentErr = await callErr(host.runtime, PLUGIN_MANAGER_CONSENT_COMMAND, {
        id: 'broken.bad-json',
        version: '1.0.0',
        permissions: [],
      });
      expect(consentErr).toContain('MANIFEST_INVALID');
      expect(consentErr).not.toContain('PLUGIN_NOT_FOUND');
    } finally {
      await host.runtime.dispose();
    }
  });
});

describe('G03a: pre-seeded broken plugins & resilient lock visibility', () => {
  it('surfaces broken disk dirs, broken releases, and corrupted lock records as degraded in Safe Mode, ignores storage dirs, and supports uninstall cleanup', async () => {
    const dataDir = join(root, 'g03a-data');
    const officialProfile = await writeOfficialProfile(root);
    const archivePath = join(root, 'healthy.dspack');
    await createSampleStudyPackArchive(archivePath, 'alice.healthy-pack');

    // Install one healthy package first so plugins.lock.json exists.
    const setupHost = await createHost(dataDir, officialProfile);
    try {
      const initial = await callOk<PluginManagerInventoryWithStatus>(setupHost.runtime, PLUGIN_MANAGER_LIST_COMMAND);
      await callOk(setupHost.runtime, PLUGIN_MANAGER_INSTALL_COMMAND, { path: archivePath, revision: initial.revision });
      // Also install & cleanly uninstall a second valid package to ensure retained rollback releases are NOT flagged.
      const uninstallArchive = join(root, 'uninstalled.dspack');
      await createSampleStudyPackArchive(uninstallArchive, 'alice.removed-pack');
      const rev2 = (await setupHost.store.read()).revision;
      const inst2 = await callOk<PluginManagerInstallResult>(setupHost.runtime, PLUGIN_MANAGER_INSTALL_COMMAND, {
        path: uninstallArchive,
        revision: rev2,
      });
      await callOk(setupHost.runtime, PLUGIN_MANAGER_UNINSTALL_COMMAND, { id: 'alice.removed-pack', revision: inst2.revision });
    } finally {
      await setupHost.runtime.dispose();
    }

    // 1. Corrupt one entry in plugins.lock.json while keeping alice.healthy-pack valid.
    const lockPath = join(dataDir, 'plugins', 'plugins.lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf8')) as { lockVersion: 1; plugins: Record<string, unknown> };
    lock.plugins['broken.lock-record'] = { id: 'broken.lock-record', version: 'not-semver', path: 'bad/path', enabled: true, files: {} };
    await writeFile(lockPath, JSON.stringify(lock, null, 2));

    // 2. Pre-seed an orphaned broken plugin directory with invalid JSON package.json.
    const orphanBrokenDir = join(dataDir, 'plugins', 'broken-orphan');
    await mkdir(orphanBrokenDir, { recursive: true });
    await writeFile(join(orphanBrokenDir, 'package.json'), '{ broken json', 'utf8');

    // 3. Pre-seed a broken directory under plugins/releases/broken.release/.
    const brokenReleaseDir = join(dataDir, 'plugins', 'releases', 'broken.release', '1.0.0-bad');
    await mkdir(brokenReleaseDir, { recursive: true });
    await writeFile(join(brokenReleaseDir, 'package.json'), JSON.stringify({ name: 'bad', version: '1.0.0' }), 'utf8');

    // 4. Create a normal plugin storage directory (no package.json / JS) that must NOT be misidentified.
    const storageDir = join(dataDir, 'plugins', 'workshop.storage-only');
    await mkdir(storageDir, { recursive: true });
    await writeFile(join(storageDir, 'prefs.json'), '{"theme":"dark"}', 'utf8');

    // Boot in Safe Mode (where user.profile.json is NOT loaded at startup).
    const safeHost = await createHost(dataDir, officialProfile, { safeMode: true });
    try {
      await loadStartupProfile(safeHost.runtime, { official: officialProfile, profile: officialProfile });
      const inv = await callOk<PluginManagerInventoryWithStatus>(safeHost.runtime, PLUGIN_MANAGER_LIST_COMMAND);
      const byId = new Map(inv.plugins.map((entry) => [entry.id, entry]));

      // Healthy package is NOT hidden by the corrupt lock record.
      expect(byId.get('alice.healthy-pack')).toMatchObject({
        origin: 'community',
        version: '1.0.0',
        state: 'disabled',
      });
      // Cleanly uninstalled release & plain storage dir are NOT falsely surfaced.
      expect(byId.has('alice.removed-pack')).toBe(false);
      expect(byId.has('workshop.storage-only')).toBe(false);

      // All 3 broken plugin variants ARE surfaced as degraded with structured reasons!
      expect(byId.get('broken.lock-record')).toMatchObject({
        origin: 'community',
        state: 'degraded',
        reason: expect.stringMatching(/^MANIFEST_INVALID:/),
      });
      expect(byId.get('broken-orphan')).toMatchObject({
        origin: 'community',
        state: 'degraded',
        reason: expect.stringMatching(/^MANIFEST_INVALID:/),
      });
      expect(byId.get('broken.release')).toMatchObject({
        origin: 'community',
        state: 'degraded',
        reason: expect.stringMatching(/^MANIFEST_MISSING:/),
      });

      // Uninstalling each broken entry in Safe Mode succeeds and removes disk/lock artifacts cleanly.
      let rev = inv.revision!;
      for (const brokenId of ['broken.lock-record', 'broken-orphan', 'broken.release']) {
        const res = await callOk<{ removed: boolean; revision: string }>(safeHost.runtime, PLUGIN_MANAGER_UNINSTALL_COMMAND, {
          id: brokenId,
          revision: rev,
        });
        expect(res.removed).toBe(true);
        rev = res.revision;
      }

      expect(existsSync(orphanBrokenDir)).toBe(false);
      expect(existsSync(join(dataDir, 'plugins', 'releases', 'broken.release'))).toBe(false);
      const afterUninstall = await callOk<PluginManagerInventoryWithStatus>(safeHost.runtime, PLUGIN_MANAGER_LIST_COMMAND);
      const remainingIds = afterUninstall.plugins.map((entry) => entry.id);
      expect(remainingIds).not.toContain('broken.lock-record');
      expect(remainingIds).not.toContain('broken-orphan');
      expect(remainingIds).not.toContain('broken.release');
      expect(remainingIds).toContain('alice.healthy-pack');
    } finally {
      await safeHost.runtime.dispose();
    }
  });
});
