import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeFiles } from '../../platform/files/index.ts';
import { ContractSet } from '../contract-set.ts';
import { mountDeclarativeAssets } from '../declarative-loader.ts';
import { checkManifest } from '../manifest.ts';
import { PluginPackages } from '../plugin-packages/index.ts';
import { HostRuntime } from '../runtime.ts';
import { GradingRubricRegistry } from '../../plugins/llm/src/essay_grading/rubric-registry.ts';
import { exportFileName } from '../../plugins/plugin-workshop/src/operations.ts';
import {
  createStudyPackArchive,
  exportPackageExtension,
  rewriteManifestForSharing,
} from '../../plugins/plugin-workshop/src/study-pack.ts';

const enc = new TextEncoder();

describe('Plugin System v2 P4 — .dspack Study Pack Export/Import & Share-Time Namespace Flow', () => {
  it('resolves package extensions and workshop export file names by manifest kind', () => {
    expect(exportPackageExtension()).toBe('.dstuplugin');
    expect(exportPackageExtension('plugin')).toBe('.dstuplugin');
    expect(exportPackageExtension('study-pack')).toBe('.dspack');

    expect(exportFileName('Kaoyan Math', '1.0.0')).toBe('Kaoyan Math-v1.0.0.dstuplugin');
    expect(exportFileName('Kaoyan Math', '1.0.0', 'plugin')).toBe('Kaoyan Math-v1.0.0.dstuplugin');
    expect(exportFileName('Kaoyan Math', '1.0.0', 'study-pack')).toBe('Kaoyan Math-v1.0.0.dspack');
  });

  it('rewriteManifestForSharing turns workshop.plugin-<uuid> into community namespace and strips scripts', () => {
    const workshopPkg: Record<string, unknown> = {
      name: 'workshop-temp',
      version: '1.0.0',
      scripts: { postinstall: 'echo should-be-stripped' },
      engines: { deepStudent: '^0.20', deepStudentPluginApi: '2' },
      deepStudent: {
        manifestVersion: 2,
        id: 'workshop.plugin-11111111-1111-4111-8111-111111111111',
        kind: 'study-pack',
        displayName: 'Kaoyan Math Pack',
        platforms: ['desktop', 'mobile'],
        declarative: {
          rubrics: ['./rubrics/kaoyan-math.yaml'],
          skills: ['./skills/kaoyan-coach.md'],
        },
      },
    };

    const rewritten = rewriteManifestForSharing(workshopPkg, {
      publisher: 'alice',
      slug: 'kaoyan-math-pack',
      author: 'Alice',
      displayName: '考研数学冲刺包',
    });

    // Does not mutate caller's original package.json object
    expect((workshopPkg.deepStudent as Record<string, unknown>).id).toBe(
      'workshop.plugin-11111111-1111-4111-8111-111111111111',
    );
    expect(workshopPkg.scripts).toBeDefined();

    expect(rewritten.name).toBe('deepstudent-pack-kaoyan-math-pack');
    expect(rewritten.scripts).toBeUndefined();
    expect(rewritten.deepStudent).toMatchObject({
      id: 'alice.kaoyan-math-pack',
      kind: 'study-pack',
      author: 'Alice',
      displayName: '考研数学冲刺包',
    });

    const verified = checkManifest(rewritten, {
      appVersion: '0.20.9',
      context: 'community-install',
      platform: 'desktop',
    });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.manifest.id).toBe('alice.kaoyan-math-pack');
      expect(verified.manifest.kind).toBe('study-pack');
      expect(verified.manifest.tier).toBe('declarative');
    }
  });

  it('derives safe slug from displayName or existing local id when omitted, and names normal plugins properly', () => {
    const localPlugin: Record<string, unknown> = {
      name: 'local-scratch',
      version: '0.2.0',
      engines: { deepStudent: '^0.20' },
      deepStudent: {
        manifestVersion: 2,
        id: 'local.flashcard-helper',
        displayName: 'Flashcard Helper!',
        platforms: ['desktop'],
        ui: './dist/ui.js',
      },
    };

    const rewritten = rewriteManifestForSharing(localPlugin, { publisher: 'alice' });
    expect(rewritten.name).toBe('deepstudent-plugin-flashcard-helper');
    expect((rewritten.deepStudent as Record<string, unknown>).id).toBe('alice.flashcard-helper');
  });

  it('rejects forbidden, assigned, and invalid publishers in rewriteManifestForSharing', () => {
    const basePkg: Record<string, unknown> = {
      name: 'workshop-temp',
      version: '1.0.0',
      engines: { deepStudent: '^0.20' },
      deepStudent: {
        manifestVersion: 2,
        id: 'workshop.plugin-11111111-1111-4111-8111-111111111111',
        kind: 'study-pack',
        platforms: ['desktop'],
        declarative: { skills: ['./skills/s.md'] },
      },
    };

    for (const forbidden of ['community', 'ds', 'deepstudent', 'deep-student', 'official', 'builtin', 'system']) {
      expect(() => rewriteManifestForSharing(basePkg, { publisher: forbidden, slug: 'pack' })).toThrow(
        /SHARE_PUBLISHER_FORBIDDEN/,
      );
    }

    for (const reserved of ['dstu', 'local', 'test', 'example', 'workshop']) {
      expect(() => rewriteManifestForSharing(basePkg, { publisher: reserved, slug: 'pack' })).toThrow(
        /SHARE_PUBLISHER_RESERVED/,
      );
    }

    for (const invalid of ['', 'a', 'Alice', '123pub', 'bad_pub']) {
      expect(() => rewriteManifestForSharing(basePkg, { publisher: invalid, slug: 'pack' })).toThrow(
        /SHARE_PUBLISHER_INVALID/,
      );
    }
  });

  it('packs a .dspack ZIP, installs via PluginPackages, mounts declarative assets in HostRuntime, and cleans up on unload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dstu-study-pack-e2e-'));
    try {
      const workshopPkg: Record<string, unknown> = {
        name: 'workshop-kaoyan-draft',
        version: '1.0.0',
        scripts: { build: 'echo strip-me' },
        engines: { deepStudent: '^0.20', deepStudentPluginApi: '2' },
        deepStudent: {
          manifestVersion: 2,
          id: 'workshop.plugin-22222222-2222-4222-8222-222222222222',
          kind: 'study-pack',
          displayName: '考研数学证明冲刺包',
          platforms: ['desktop', 'mobile'],
          declarative: {
            rubrics: ['./rubrics/kaoyan-math.yaml'],
            skills: ['./skills/kaoyan-coach.md'],
            workflows: ['./workflows/sprint.yaml'],
          },
        },
      };

      const sharedPkg = rewriteManifestForSharing(workshopPkg, {
        publisher: 'alice',
        slug: 'kaoyan-math-pack',
        author: 'Alice',
      });

      const rubricYaml = `
id: kaoyan-math-proof
name: 考研数学证明题严格批改
description: 按逻辑严密性、步骤完整度、边界讨论三维度打分
systemPrompt: 你是考研数学阅卷专家，请逐步骤核查证明严密性并指出逻辑跳步。
scoreDimensions:
  - name: 逻辑严密性
    maxScore: 6
    description: 定理条件与推导链是否闭合
  - name: 步骤完整度
    maxScore: 4
    description: 关键中间结论是否充分写出
totalMaxScore: 10
`;

      const skillMarkdown = `---
id: kaoyan-coach
name: 考研数学证明教练
description: 引导学习者先列已知条件与待证目标，再定位中值定理或构造辅助函数
---
# 考研数学证明教练
在给出完整解答前，先要求学习者写出所选定理的前提条件。
`;

      const workflowYaml = `
id: kaoyan-sprint
name: 考研数学证明题闭环冲刺
trigger: /kaoyan-sprint
steps:
  - id: diagnose
    title: 定位薄弱证明题型
    prompt: 扫描近 14 天中值定理与不等式证明错题并归类
  - id: practice
    title: 阶梯式变式训练
    prompt: 生成 2 道递进难度证明题并逐题批改
`;

      const archiveBytes = await createStudyPackArchive([
        { path: 'package.json', bytes: enc.encode(`${JSON.stringify(sharedPkg, null, 2)}\n`) },
        { path: 'rubrics/kaoyan-math.yaml', bytes: enc.encode(rubricYaml) },
        { path: 'skills/kaoyan-coach.md', bytes: enc.encode(skillMarkdown) },
        { path: 'workflows/sprint.yaml', bytes: enc.encode(workflowYaml) },
      ]);

      const files = createNodeFiles({ roots: [{ name: 'appData', path: root }] });
      const pluginsScope = files.scope(join(root, 'plugins'));
      const packages = new PluginPackages(pluginsScope);

      const archivePath = join(root, 'incoming', 'kaoyan-v1.0.0.dspack');
      await files.writeBytes(archivePath, archiveBytes, { createParents: true });

      const archiveHandle = await files.openFile(archivePath);
      let installResult;
      try {
        installResult = await packages.install(archiveHandle, 'kaoyan-v1.0.0.dspack', {
          appVersion: '0.20.9',
          platform: 'desktop',
          installed: new Map(),
        });
      } finally {
        await archiveHandle.close();
      }

      expect(installResult.manifest.id).toBe('alice.kaoyan-math-pack');
      expect(installResult.manifest.kind).toBe('study-pack');
      expect(installResult.manifest.tier).toBe('declarative');
      expect(Object.keys(installResult.record.files).sort()).toEqual([
        'package.json',
        'rubrics/kaoyan-math.yaml',
        'skills/kaoyan-coach.md',
        'workflows/sprint.yaml',
      ]);

      await packages.setEnabled('alice.kaoyan-math-pack', true);
      const verifiedRecord = await packages.verify('alice.kaoyan-math-pack');
      const releaseDir = pluginsScope.resolve(verifiedRecord.path);

      const runtime = new HostRuntime({
        app: { version: '0.20.9', dataDir: root, platform: 'darwin', debug: false },
        contracts: new ContractSet([]),
      });
      runtime.setDeclarativeLoader(mountDeclarativeAssets);
      const rubrics = new GradingRubricRegistry();
      runtime.ctx.provide('gradingRubrics', rubrics);

      await runtime.installEntry({
        plugin: {
          name: installResult.manifest.id,
          meta: {
            id: installResult.manifest.id,
            version: installResult.manifest.version,
            platforms: [...installResult.manifest.platforms],
          },
          apply() {},
        },
        packageRoot: releaseDir,
        manifest: installResult.manifest,
      });

      const mountedRubric = rubrics.get('alice.kaoyan-math-pack:kaoyan-math-proof');
      expect(mountedRubric).not.toBeNull();
      expect(mountedRubric?.name).toBe('考研数学证明题严格批改');
      expect(mountedRubric?.totalMaxScore).toBe(10);

      expect(runtime.declarativeAssets.listRubricIdsByPlugin('alice.kaoyan-math-pack')).toEqual([
        'alice.kaoyan-math-pack:kaoyan-math-proof',
      ]);
      expect(runtime.declarativeAssets.listSkills()).toHaveLength(1);
      expect(runtime.declarativeAssets.listSkills()[0]).toMatchObject({
        pluginId: 'alice.kaoyan-math-pack',
        skillId: 'kaoyan-coach',
        name: '考研数学证明教练',
      });
      expect(runtime.declarativeAssets.listWorkflows()).toHaveLength(1);
      expect(runtime.declarativeAssets.listWorkflows()[0]).toMatchObject({
        pluginId: 'alice.kaoyan-math-pack',
        id: 'kaoyan-sprint',
        trigger: '/kaoyan-sprint',
      });
      expect(runtime.declarativeAssets.listWorkflows()[0]?.steps).toHaveLength(2);

      // Unload cleanly removes every mounted rubric, skill, and workflow
      await runtime.unload('alice.kaoyan-math-pack');
      expect(rubrics.get('alice.kaoyan-math-pack:kaoyan-math-proof')).toBeNull();
      expect(runtime.declarativeAssets.listRubricIdsByPlugin('alice.kaoyan-math-pack')).toEqual([]);
      expect(runtime.declarativeAssets.listSkills()).toEqual([]);
      expect(runtime.declarativeAssets.listWorkflows()).toEqual([]);

      await runtime.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a .dspack archive whose declared declarative asset is missing from the ZIP', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dstu-study-pack-missing-'));
    try {
      const pkg = rewriteManifestForSharing(
        {
          name: 'workshop-missing-asset',
          version: '1.0.0',
          engines: { deepStudent: '^0.20' },
          deepStudent: {
            manifestVersion: 2,
            id: 'workshop.plugin-33333333-3333-4333-8333-333333333333',
            kind: 'study-pack',
            platforms: ['desktop'],
            declarative: {
              rubrics: ['./rubrics/missing.yaml'],
            },
          },
        },
        { publisher: 'alice', slug: 'broken-pack' },
      );

      const bytes = await createStudyPackArchive([
        { path: 'package.json', bytes: enc.encode(`${JSON.stringify(pkg, null, 2)}\n`) },
      ]);

      const files = createNodeFiles({ roots: [{ name: 'appData', path: root }] });
      const packages = new PluginPackages(files.scope(join(root, 'plugins')));
      const archivePath = join(root, 'incoming', 'broken-v1.0.0.dspack');
      await files.writeBytes(archivePath, bytes, { createParents: true });

      const archiveHandle = await files.openFile(archivePath);
      try {
        await expect(
          packages.install(archiveHandle, 'broken-v1.0.0.dspack', {
            appVersion: '0.20.9',
            platform: 'desktop',
            installed: new Map(),
          }),
        ).rejects.toThrow(/missing declarative\.rubrics asset \.\/rubrics\/missing\.yaml/);
      } finally {
        await archiveHandle.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
