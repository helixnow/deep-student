import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostRuntime } from '../runtime.ts';
import { mountDeclarativeAssets } from '../declarative-loader.ts';
import { ContractSet } from '../contract-set.ts';
import {
  checkManifest,
  grantedNetHosts,
  grantedNetLocalPorts,
  grantedNetWriteHosts,
  isHighRiskPermission,
} from '../manifest.ts';
import { GradingRubricRegistry } from '../../plugins/llm/src/essay_grading/rubric-registry.ts';
import { compileWorkshop, checkWorkshopLifecycle } from '../../plugins/plugin-workshop/src/compiler.ts';
import { declaredCapabilities } from '../../plugins/plugin-workshop/src/declared.ts';

describe('Plugin System v2 P3 — Manifest v2, Tier 1 Declarative Loader & Workshop Self-Check', () => {
  it('parses v2 permissions (net:write, net:local) and infers tiers accurately', () => {
    const pkg = {
      name: 'deepstudent-pack-kaoyan',
      version: '1.0.0',
      engines: { deepStudent: '^0.20', deepStudentPluginApi: '2' },
      deepStudent: {
        manifestVersion: 2,
        id: 'alice.kaoyan-pack',
        kind: 'study-pack',
        platforms: ['desktop', 'mobile'],
        host: './host.ts',
        declarative: {
          rubrics: ['./rubrics/kaoyan.yaml'],
          skills: ['./skills/SKILL.md'],
        },
        permissions: [
          'service:gradingRubrics',
          'net:api.example.org',
          'net:write:api.notion.com',
          'net:local:8765',
        ],
      },
    };
    const res = checkManifest(pkg, { appVersion: '0.20.9', context: 'community-install', platform: 'desktop' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.manifestVersion).toBe(2);
    expect(res.manifest.kind).toBe('study-pack');
    expect(res.manifest.tier).toBe('full');
    expect(grantedNetHosts(res.manifest)).toEqual(['api.example.org']);
    expect(grantedNetWriteHosts(res.manifest)).toEqual(['api.notion.com']);
    expect(grantedNetLocalPorts(res.manifest)).toEqual([8765]);
    expect(isHighRiskPermission('net:write:api.notion.com')).toBe(true);
    expect(isHighRiskPermission('net:local:8765')).toBe(true);
    expect(isHighRiskPermission('net:api.example.org')).toBe(false);

    const lines = declaredCapabilities(res.manifest);
    expect(lines.some(l => l.includes('向 api.notion.com 发送写入请求'))).toBe(true);
    expect(lines.some(l => l.includes('访问本机端口 8765'))).toBe(true);
    expect(lines.some(l => l.includes('批改标准'))).toBe(true);
  });

  it('mounts pure Tier 1 declarative rubrics/skills/cardTemplates/workflows and cleans them up on unload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dstu-tier1-'));
    try {
      await mkdir(join(dir, 'rubrics'), { recursive: true });
      await mkdir(join(dir, 'skills'), { recursive: true });
      await mkdir(join(dir, 'templates'), { recursive: true });
      await mkdir(join(dir, 'workflows'), { recursive: true });

      await writeFile(join(dir, 'rubrics/ielts.yaml'), `
id: ielts-task2
name: 雅思 Task 2 严苛批改
description: 按 TR/CC/LR/GRA 四维严格打分
systemPrompt: 你是资深雅思考官，请按四维度严格评分。
scoreDimensions:
  - name: Task Response
    maxScore: 9
    description: 审题与论证深度
  - name: Coherence and Cohesion
    maxScore: 9
    description: 逻辑衔接
totalMaxScore: 9
`, 'utf8');

      await writeFile(join(dir, 'skills/socratic.md'), `---
id: socratic-essay
name: 苏格拉底论文反问法
description: 写作前先追问三个核心论点
---
# 苏格拉底论文反问法
先让学习者用一句话陈述核心论点，再追问反例。
`, 'utf8');

      await writeFile(join(dir, 'templates/cloze.yaml'), `
id: math-proof-cloze
name: 数学证明关键步挖空卡
frontTemplate: "定理：{{theorem}}\\n关键一步：{{cloze}}"
backTemplate: "完整证明：{{proof}}"
fields: [theorem, cloze, proof]
tags: [math, proof]
`, 'utf8');

      await writeFile(join(dir, 'workflows/review-loop.yaml'), `
id: pre-exam-sprint
name: 考前错题闭环冲刺
trigger: /sprint
steps:
  - id: scan
    title: 扫描近 7 天错题
    prompt: 列出最近 7 天错误率最高的 3 个知识点
  - id: drill
    title: 生成变式巩固题
    prompt: 针对每个知识点各出 1 道变式题
`, 'utf8');

      const pkg = {
        name: 'deepstudent-pack-ielts-kit',
        version: '1.0.0',
        engines: { deepStudent: '^0.20' },
        deepStudent: {
          manifestVersion: 2,
          id: 'alice.ielts-kit',
          kind: 'study-pack',
          platforms: ['desktop', 'mobile'],
          declarative: {
            rubrics: ['./rubrics/ielts.yaml'],
            skills: ['./skills/socratic.md'],
            cardTemplates: ['./templates/cloze.yaml'],
            workflows: ['./workflows/review-loop.yaml'],
          },
        },
      };
      const checked = checkManifest(pkg, { appVersion: '0.20.9', context: 'community-install', platform: 'desktop' });
      expect(checked.ok).toBe(true);
      if (!checked.ok) return;
      expect(checked.manifest.tier).toBe('declarative');

      const runtime = new HostRuntime({
        app: { version: '0.20.9', dataDir: dir },
        contracts: new ContractSet([]),
      });
      runtime.setDeclarativeLoader(mountDeclarativeAssets);
      const rubrics = new GradingRubricRegistry();
      runtime.ctx.provide('gradingRubrics', rubrics);

      await runtime.installEntry({
        plugin: {
          meta: { id: checked.manifest.id, version: checked.manifest.version, platforms: ['desktop', 'mobile'] },
          apply() {},
        },
        packageRoot: dir,
        manifest: checked.manifest,
      });

      expect(rubrics.get('alice.ielts-kit:ielts-task2')?.name).toBe('雅思 Task 2 严苛批改');
      expect(runtime.declarativeAssets.listSkills()).toHaveLength(1);
      expect(runtime.declarativeAssets.listSkills()[0]?.skillId).toBe('socratic-essay');
      expect(runtime.declarativeAssets.listCardTemplates()).toHaveLength(1);
      expect(runtime.declarativeAssets.listWorkflows()).toHaveLength(1);
      expect(runtime.declarativeAssets.listWorkflows()[0]?.steps).toHaveLength(2);

      // Unload cleanly removes all declarative contributions
      await runtime.unload('alice.ielts-kit');
      expect(rubrics.get('alice.ielts-kit:ielts-task2')).toBeNull();
      expect(runtime.declarativeAssets.listSkills()).toHaveLength(0);
      expect(runtime.declarativeAssets.listCardTemplates()).toHaveLength(0);
      expect(runtime.declarativeAssets.listWorkflows()).toHaveLength(0);
      await runtime.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('compiles and passes Workshop lifecycle self-check for UI-only and pure declarative packages', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dstu-workshop-tier1-'));
    const srcDir = join(dir, 'src');
    const buildsDir = join(dir, 'builds');
    try {
      await mkdir(join(srcDir, 'rubrics'), { recursive: true });
      await writeFile(join(srcDir, 'rubrics/custom.yaml'), `
id: gaokao-cn
name: 高考语文议论文
systemPrompt: 按高考议论文一类文标准批改
scoreDimensions:
  - name: 立意
    maxScore: 20
  - name: 结构
    maxScore: 20
  - name: 语言
    maxScore: 20
`, 'utf8');
      await writeFile(join(srcDir, 'package.json'), JSON.stringify({
        name: 'deepstudent-pack-gaokao',
        version: '0.1.0',
        engines: { deepStudent: '^0.20' },
        deepStudent: {
          manifestVersion: 2,
          id: 'workshop.plugin-11111111-1111-4111-8111-111111111111',
          displayName: '高考议论文批改包',
          kind: 'study-pack',
          platforms: ['desktop', 'mobile'],
          declarative: { rubrics: ['./rubrics/custom.yaml'] },
        },
      }), 'utf8');

      const app = { version: '0.20.9', dataDir: dir };
      const build = await compileWorkshop(srcDir, buildsDir, 'workshop.plugin-11111111-1111-4111-8111-111111111111', app);
      expect(build.check.manifest).toBe('passed');
      expect(build.check.compile).toBe('passed');

      const lifecycle = await checkWorkshopLifecycle(build, app);
      expect(lifecycle.ok).toBe(true);
      expect(lifecycle.lifecycle).toBe('passed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
