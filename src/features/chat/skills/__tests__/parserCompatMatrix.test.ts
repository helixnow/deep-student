import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildNearLimitSkillMarkdown,
  buildOversizedSkillMarkdown,
  FRONTMATTER_LENGTH_LIMIT,
} from '../__fixtures__/compat/buildLongFrontmatter';
import { parseSkillFile, serializeSkillToMarkdown } from '../parser';
import { generateAvailableSkillsPrompt } from '../progressiveDisclosure';
import { skillRegistry } from '../registry';
import { __setRequiresGateForTest } from '../requiresGating';
import type { SkillDefinition } from '../types';

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../__fixtures__/compat'
);

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8');
}

function parseFixture(name: string, skillId = name.replace(/\.md$/, '')) {
  return parseSkillFile(loadFixture(name), `/fixtures/${name}`, skillId, 'global');
}

function roundTrip(skill: SkillDefinition) {
  const serialized = serializeSkillToMarkdown(
    {
      name: skill.name,
      description: skill.description,
      version: skill.version,
      author: skill.author,
      license: skill.license,
      homepage: skill.homepage,
      tags: skill.tags,
      compatibility: skill.compatibility,
      priority: skill.priority,
      allowedTools: skill.allowedTools,
      tools: skill.tools,
      disableAutoInvoke: skill.disableAutoInvoke,
      userInvocable: skill.userInvocable,
      argumentHint: skill.argumentHint,
      embeddedTools: skill.embeddedTools,
      skillType: skill.skillType,
      relatedSkills: skill.relatedSkills,
      dependencies: skill.dependencies,
      requires: skill.requires,
      manifestVersion: skill.manifestVersion,
      preservedFrontmatter: skill.preservedFrontmatter,
    },
    skill.content
  );
  return parseSkillFile(serialized, skill.sourcePath, skill.id, skill.location);
}

describe('SKILL.md parser compatibility matrix', () => {
  it('parses anthropic-style pdf-processing with license/homepage/tags/compatibility', () => {
    const result = parseFixture('anthropic-pdf-processing.md', 'pdf-processing');
    expect(result.success).toBe(true);
    expect(result.skill).toMatchObject({
      id: 'pdf-processing',
      name: 'pdf-processing',
      license: 'Apache-2.0',
      homepage: 'https://github.com/anthropics/skills/tree/main/skills/pdf',
      tags: ['documents', 'pdf', 'extraction'],
      compatibility:
        'Requires pdftotext or equivalent PDF tooling; network optional',
      version: '1.0.0',
      author: 'anthropics',
      allowedTools: ['Read', 'Bash'],
      disableAutoInvoke: false,
    });
    expect(result.skill!.description.length).toBeGreaterThan(50);
    expect(result.warnings ?? []).toEqual([]);

    const again = roundTrip(result.skill!);
    expect(again.success).toBe(true);
    expect(again.skill?.license).toBe('Apache-2.0');
    expect(again.skill?.homepage).toBe(result.skill!.homepage);
    expect(again.skill?.tags).toEqual(result.skill!.tags);
    expect(again.skill?.compatibility).toBe(result.skill!.compatibility);
  });

  it('maps disable-model-invocation to disableAutoInvoke and keeps user/argument fields', () => {
    const result = parseFixture('anthropic-commit-skill.md', 'commit');
    expect(result.success).toBe(true);
    expect(result.skill?.disableAutoInvoke).toBe(true);
    expect(result.skill?.userInvocable).toBe(true);
    expect(result.skill?.argumentHint).toBe('[scope]');
    expect(result.skill?.license).toBe('MIT');
    expect(result.skill?.tags).toEqual(['git', 'workflow']);
    expect(result.skill?.preservedFrontmatter?.['disable-model-invocation']).toBeUndefined();

    const again = roundTrip(result.skill!);
    expect(again.skill?.disableAutoInvoke).toBe(true);
    expect(again.skill?.userInvocable).toBe(true);
    expect(again.skill?.argumentHint).toBe('[scope]');
  });

  it('takes the more conservative disable flag when both native and anthropic keys exist', () => {
    const result = parseFixture(
      'anthropic-conservative-disable.md',
      'deploy-staging'
    );
    expect(result.success).toBe(true);
    // disableAutoInvoke: false + disable-model-invocation: true → true
    expect(result.skill?.disableAutoInvoke).toBe(true);
    expect(result.skill?.userInvocable).toBe(true);
    expect(result.skill?.argumentHint).toBe('[service]');
    expect(result.skill?.compatibility).toContain('kubectl');
  });



  it('merges top-level requires with top-level metadata requires (unique union)', () => {
    const result = parseFixture(
      'compat-scripts-and-requires.md',
      'pandoc-export'
    );
    expect(result.success).toBe(true);
    expect(result.skill?.requires?.bins).toEqual([
      'pandoc',
      'python3',
      'soffice',
    ]);
    expect(result.skill?.requires?.env).toEqual([
      'PANDOC_REFERENCE_DOC',
      'HOME',
    ]);
    expect(result.skill?.skillType).toBe('standalone');
    expect(result.skill?.allowedTools).toEqual(['Bash', 'Read', 'Write']);
    expect(result.skill!.content).toContain('{baseDir}/scripts/export.py');
  });

  it('parses license-only minimal anthropic skill', () => {
    const result = parseFixture('license-only-minimal.md', 'brand-guidelines');
    expect(result.success).toBe(true);
    expect(result.skill?.license).toBe('Complete terms in LICENSE.txt');
    expect(result.skill?.homepage).toBeUndefined();
    expect(result.skill?.tags).toBeUndefined();
    expect(result.skill?.compatibility).toBeUndefined();
    expect(result.skill?.disableAutoInvoke).toBe(false);
    expect(result.skill?.requires).toBeUndefined();
  });

  it('parses user-invocable false background knowledge skill', () => {
    const result = parseFixture(
      'user-invocable-false.md',
      'legacy-system-context'
    );
    expect(result.success).toBe(true);
    expect(result.skill?.userInvocable).toBe(false);
    expect(result.skill?.disableAutoInvoke).toBe(false);
    expect(result.skill?.argumentHint).toBe('[topic]');
    expect(result.skill?.tags).toEqual(['background', 'billing']);
    expect(result.skill?.compatibility).toContain('Read-only');

    const again = roundTrip(result.skill!);
    expect(again.skill?.userInvocable).toBe(false);
    expect(again.skill?.argumentHint).toBe('[topic]');
  });

  it('fails cleanly on illegal YAML frontmatter boundaries', () => {
    const result = parseFixture('invalid-yaml-boundary.md', 'broken-frontmatter');
    expect(result.success).toBe(false);
    expect(result.skill).toBeUndefined();
    expect(result.error).toBeTruthy();
    expect(String(result.error)).toMatch(/YAML|yaml|parse|解析/i);
  });

  it('requires the closing frontmatter delimiter to occupy its own line', () => {
    const result = parseSkillFile(
      [
        '---',
        'name: delimiter-test',
        'description: Closing delimiter regression test',
        '---not-a-delimiter',
        '# body',
      ].join('\n'),
      '/fixtures/delimiter-test.md',
      'delimiter-test',
      'global',
    );
    expect(result.success).toBe(false);
    expect(result.skill).toBeUndefined();
  });

  it('parses flow-map and OpenClaw nested requires consistently', () => {
    const flow = parseSkillFile(
      [
        '---',
        'name: flow-requires',
        'description: Flow map compatibility',
        'requires: { bins: [node, uv], env: [API_KEY] }',
        '---',
        '# body',
      ].join('\n'),
      '/fixtures/flow-requires.md',
      'flow-requires',
      'global',
    );
    expect(flow.skill?.requires).toEqual({
      bins: ['node', 'uv'],
      env: ['API_KEY'],
    });

    const nested = parseSkillFile(
      [
        '---',
        'name: openclaw-requires',
        'description: OpenClaw nested compatibility',
        'metadata:',
        '  openclaw:',
        '    requires:',
        '      bins: [rg]',
        '      env: [SEARCH_TOKEN]',
        '---',
        '# body',
      ].join('\n'),
      '/fixtures/openclaw-requires.md',
      'openclaw-requires',
      'global',
    );
    expect(nested.skill?.requires).toEqual({
      bins: ['rg'],
      env: ['SEARCH_TOKEN'],
    });
  });

  it('preserves unknown marketplace keys while elevating first-class fields', () => {
    const result = parseFixture(
      'unknown-keys-preserved.md',
      'marketplace-listing'
    );
    expect(result.success).toBe(true);
    expect(result.skill?.license).toBe('MIT');
    expect(result.skill?.homepage).toBe(
      'https://skills.example/marketplace-listing'
    );
    expect(result.skill?.tags).toEqual(['marketplace', 'demo']);
    expect(result.skill?.compatibility).toBe(
      'Works with AgentSkills-compatible hosts'
    );
    expect(result.skill?.preservedFrontmatter).toMatchObject({
      'x-marketplace-score': 98,
      'x-install-hint': 'npx skills add marketplace-listing',
      'custom-config': { channel: 'stable', region: 'cn' },
    });
    // First-class fields must not leak into preserved bag
    expect(result.skill?.preservedFrontmatter?.license).toBeUndefined();
    expect(result.skill?.preservedFrontmatter?.tags).toBeUndefined();

    const again = roundTrip(result.skill!);
    expect(again.skill?.preservedFrontmatter).toMatchObject({
      'x-marketplace-score': 98,
      'custom-config': { channel: 'stable', region: 'cn' },
    });
    expect(again.skill?.license).toBe('MIT');
    expect(again.skill?.tags).toEqual(['marketplace', 'demo']);
  });

  it('parses anthropic full meta combo (list allowed-tools + argument-hint + priority)', () => {
    const result = parseFixture(
      'anthropic-full-meta-combo.md',
      'academic-citation-helper'
    );
    expect(result.success).toBe(true);
    expect(result.skill).toMatchObject({
      id: 'academic-citation-helper',
      name: 'academic-citation-helper',
      license: 'Apache-2.0',
      homepage:
        'https://github.com/anthropics/skills/tree/main/skills/citation',
      tags: ['academic', 'citation', 'writing'],
      compatibility: expect.stringContaining('Offline'),
      version: '2.4.0',
      author: 'anthropics',
      disableAutoInvoke: false,
      userInvocable: true,
      argumentHint: '[style] [doi-or-title]',
      allowedTools: ['Read', 'Write', 'Grep'],
      priority: 2,
      skillType: 'standalone',
    });

    const again = roundTrip(result.skill!);
    expect(again.skill?.allowedTools).toEqual(['Read', 'Write', 'Grep']);
    expect(again.skill?.argumentHint).toBe('[style] [doi-or-title]');
    expect(again.skill?.priority).toBe(2);
  });

  it('maps disable-model-invocation alone without native disableAutoInvoke key', () => {
    const result = parseFixture(
      'anthropic-disable-model-only.md',
      'dangerous-deploy'
    );
    expect(result.success).toBe(true);
    expect(result.skill?.disableAutoInvoke).toBe(true);
    expect(result.skill?.argumentHint).toBe('[staging|prod]');
    expect(result.skill?.compatibility).toContain('kubectl');
    expect(result.skill?.tags).toEqual(['ops', 'deploy']);
  });

  it('parses anthropic allowed-tools space-separated string form', () => {
    const result = parseFixture('anthropic-allowed-tools-string.md', 'note-outline');
    expect(result.success).toBe(true);
    expect(result.skill?.allowedTools).toEqual(['Read', 'Grep']);
    expect(result.skill?.license).toBe('Complete terms in LICENSE.txt');
    expect(result.skill?.userInvocable).toBe(true);
    expect(result.skill?.argumentHint).toBe('[depth]');
  });

  it('parses top-level metadata requires with bins only', () => {
    const result = parseFixture('compat-requires-bins-only.md', 'ffmpeg-clip');
    expect(result.success).toBe(true);
    expect(result.skill?.requires).toEqual({
      bins: ['ffmpeg', 'ffprobe'],
    });
    expect(result.skill?.requires?.env).toBeUndefined();
    expect(result.skill?.allowedTools).toEqual(['Bash']);
    expect(result.skill!.content).toContain('{baseDir}/scripts/clip.sh');
  });

  it('parses top-level requires with env only (no bins)', () => {
    const result = parseFixture(
      'compat-requires-env-only.md',
      'card-sync-notes'
    );
    expect(result.success).toBe(true);
    expect(result.skill?.name).toBe('card-sync-notes');
    expect(result.skill?.requires).toEqual({
      env: ['NOTES_CLOUD_TOKEN', 'NOTES_CLOUD_DATABASE_ID'],
    });
    expect(result.skill?.requires?.bins).toBeUndefined();
    expect(result.skill?.version).toBe('1.1.0');
  });

  it('merges composite relatedSkills/dependencies with top-level JSON requires', () => {
    const result = parseFixture(
      'compat-composite-related.md',
      'research-bundle'
    );
    expect(result.success).toBe(true);
    expect(result.skill?.skillType).toBe('composite');
    expect(result.skill?.relatedSkills).toEqual([
      'knowledge-retrieval',
      'web-fetch',
    ]);
    expect(result.skill?.dependencies).toEqual(['knowledge-retrieval']);
    expect(result.skill?.requires?.bins).toEqual(['rg', 'curl']);
    expect(result.skill?.requires?.env).toEqual(['RESEARCH_CACHE_DIR']);
    expect(result.skill?.tags).toEqual(['research', 'composite']);

    const again = roundTrip(result.skill!);
    expect(again.skill?.skillType).toBe('composite');
    expect(again.skill?.requires).toEqual(result.skill?.requires);
    expect(again.skill?.relatedSkills).toEqual(result.skill?.relatedSkills);
  });

  it('accepts near-limit frontmatter and rejects oversized frontmatter', () => {
    const nearMarkdown = buildNearLimitSkillMarkdown();
    const near = parseSkillFile(
      nearMarkdown,
      '/fixtures/near-limit.md',
      'long-frontmatter-skill',
      'global'
    );
    expect(near.success).toBe(true);
    expect(near.skill?.name).toBe('long-frontmatter-skill');
    expect(near.skill?.license).toBe('MIT');
    expect(near.skill?.tags).toEqual(['stress', 'frontmatter']);
    expect(near.skill?.description.length).toBeLessThanOrEqual(1024);
    expect(typeof near.skill?.preservedFrontmatter?.['x-padding']).toBe('string');
    expect(String(near.skill?.preservedFrontmatter?.['x-padding']).length).toBeGreaterThan(
      3000
    );

    const oversized = parseSkillFile(
      buildOversizedSkillMarkdown(),
      '/fixtures/oversized.md',
      'oversized-frontmatter-skill',
      'global'
    );
    expect(oversized.success).toBe(false);
    expect(oversized.skill).toBeUndefined();
    expect(String(oversized.error)).toMatch(/过长|too long|frontmatter/i);
    expect(FRONTMATTER_LENGTH_LIMIT).toBe(64 * 1024);
  });
});

describe('available_skills requires gating (injection path parity)', () => {
  beforeEach(() => {
    skillRegistry.reset();
    for (const id of [
      'ok-skill',
      'gated-skill',
      'ffmpeg-clip',
      'card-sync-notes',
      'dangerous-deploy',
    ]) {
      __setRequiresGateForTest(id, null);
    }
  });

  afterEach(() => {
    skillRegistry.reset();
    for (const id of [
      'ok-skill',
      'gated-skill',
      'ffmpeg-clip',
      'card-sync-notes',
      'dangerous-deploy',
    ]) {
      __setRequiresGateForTest(id, null);
    }
  });

  function registerPair() {
    const base = {
      version: '1.0.0',
      priority: 3,
      disableAutoInvoke: false,
      skillType: 'standalone' as const,
      content: '# body',
      sourcePath: '/tmp/SKILL.md',
      location: 'global' as const,
      trustStatus: 'trusted' as const,
      embeddedTools: [],
    };

    skillRegistry.register({
      ...base,
      id: 'ok-skill',
      name: 'OK Skill',
      description:
        'A skill with satisfied requires used to verify available_skills injection gating behavior.',
    });
    skillRegistry.register({
      ...base,
      id: 'gated-skill',
      name: 'Gated Skill',
      description:
        'A skill whose requires are unsatisfied and must be annotated unavailable in available_skills.',
      requires: { bins: ['nonexistent-bin-xyz'], env: ['MISSING_ENV_XYZ'] },
    });
  }

  it('generateAvailableSkillsPrompt annotates unsatisfied requires like generateMetadataPrompt', () => {
    registerPair();
    __setRequiresGateForTest('ok-skill', {
      satisfied: true,
      missingBins: [],
      missingEnv: [],
    });
    __setRequiresGateForTest('gated-skill', {
      satisfied: false,
      missingBins: ['nonexistent-bin-xyz'],
      missingEnv: ['MISSING_ENV_XYZ'],
    });

    const xmlPrompt = generateAvailableSkillsPrompt();
    const metaPrompt = skillRegistry.generateMetadataPrompt();

    // Available skill appears as a normal entry
    expect(xmlPrompt).toContain('id="ok-skill"');
    expect(xmlPrompt).not.toMatch(
      /id="ok-skill"[^>]*available="false"/
    );
    expect(metaPrompt).toContain('ok-skill');

    // Gated skill is annotated unavailable (not silently treated as available)
    expect(xmlPrompt).toMatch(
      /id="gated-skill"[^>]*available="false"/
    );
    expect(xmlPrompt).toContain('缺少命令 nonexistent-bin-xyz');
    expect(xmlPrompt).toContain('缺少环境变量 MISSING_ENV_XYZ');
    expect(metaPrompt).toContain('gated-skill');
    expect(metaPrompt).toContain('缺少命令 nonexistent-bin-xyz');
    expect(metaPrompt).toContain('缺少环境变量 MISSING_ENV_XYZ');
    expect(metaPrompt).toContain('暂不可用');
  });

  it('hides disableAutoInvoke skills from both injection paths', () => {
    skillRegistry.register({
      id: 'manual-only',
      name: 'Manual Only',
      description:
        'Manual-only skill that must not appear in available_skills auto-invoke prompts at all.',
      priority: 3,
      disableAutoInvoke: true,
      skillType: 'standalone',
      content: '# body',
      sourcePath: '/tmp/manual.md',
      location: 'global',
    });

    expect(generateAvailableSkillsPrompt()).not.toContain('manual-only');
    expect(skillRegistry.generateMetadataPrompt()).not.toContain('manual-only');
  });

  it('fixture-derived requires: satisfied visible, unsatisfied annotated unavailable', () => {
    const ffmpeg = parseFixture('compat-requires-bins-only.md', 'ffmpeg-clip');
    const card = parseFixture(
      'compat-requires-env-only.md',
      'card-sync-notes'
    );
    const deploy = parseFixture(
      'anthropic-disable-model-only.md',
      'dangerous-deploy'
    );
    expect(ffmpeg.success && card.success && deploy.success).toBe(true);

    __setRequiresGateForTest('ffmpeg-clip', {
      satisfied: true,
      missingBins: [],
      missingEnv: [],
    });
    __setRequiresGateForTest('card-sync-notes', {
      satisfied: false,
      missingBins: [],
      missingEnv: ['NOTES_CLOUD_TOKEN', 'NOTES_CLOUD_DATABASE_ID'],
    });

    // 外部 fixture 技能默认 untrusted，测试里显式授信以便进入注入路径
    for (const skill of [ffmpeg.skill!, card.skill!, deploy.skill!]) {
      skill.trustStatus = 'trusted';
      skillRegistry.register(skill);
    }

    const xml = generateAvailableSkillsPrompt();

    // 满足 → 可见且无 available="false"
    expect(xml).toContain('id="ffmpeg-clip"');
    expect(xml).not.toMatch(/id="ffmpeg-clip"[^>]*available="false"/);

    // 不满足 → 标注不可用 + 缺失 env
    expect(xml).toMatch(/id="card-sync-notes"[^>]*available="false"/);
    expect(xml).toContain('缺少环境变量 NOTES_CLOUD_TOKEN');
    expect(xml).toContain('缺少环境变量 NOTES_CLOUD_DATABASE_ID');

    // disable-model-invocation → 从注入路径隐藏
    expect(xml).not.toContain('dangerous-deploy');
  });
});
