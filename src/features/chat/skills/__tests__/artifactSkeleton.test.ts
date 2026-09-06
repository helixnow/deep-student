/**
 * P3 产物模板骨架（artifactSkeleton）测试
 *
 * 覆盖：frontmatter artifact 解析/序列化 round-trip、骨架块类型校验、
 * layoutLock 语义、skill 正文注入、激活 skill 查找。
 */

import { describe, expect, it } from 'vitest';

import { parseSkillFile, serializeSkillToMarkdown } from '../parser';
import {
  findActiveArtifactSkill,
  renderSkillContentWithArtifact,
  validateArtifactSkeletonTypes,
  validateIntentAgainstSkeleton,
} from '../artifactSkeleton';
import type { SkillArtifactDeclaration, SkillDefinition } from '../types';
import type { GenerativeUIIntent } from '@/features/generative-ui/types';

const SKELETON = {
  version: '1.1',
  layout: { mode: 'grid', columns: 2 },
  blocks: [
    { type: 'stat-card', props: { label: '掌握度' } },
    { type: 'progress', props: { value: 0 } },
  ],
};

function buildSkillMarkdown(artifactYaml?: string): string {
  const artifactBlock = artifactYaml ? `\n${artifactYaml}` : '';
  return `---
name: weekly-report
description: 生成周度学习报告${artifactBlock}
---

# 周度学习报告

正文内容。
`;
}

const ARTIFACT_YAML = `artifact:
  intentSkeleton:
    version: '1.1'
    layout: { mode: grid, columns: 2 }
    blocks:
      - { type: stat-card, props: { label: 掌握度 } }
      - { type: progress, props: { value: 0 } }
  dataTools: [query_review_stats]
  layoutLock: true`;

function parseWithArtifact(artifactYaml?: string) {
  return parseSkillFile(
    buildSkillMarkdown(artifactYaml),
    '/fixtures/weekly-report.md',
    'weekly-report',
    'global',
  );
}

describe('artifact frontmatter 解析', () => {
  it('解析 intentSkeleton / dataTools / layoutLock', () => {
    const result = parseWithArtifact(ARTIFACT_YAML);
    expect(result.success).toBe(true);
    const artifact = result.skill?.artifact;
    expect(artifact).toBeDefined();
    expect(artifact?.layoutLock).toBe(true);
    expect(artifact?.dataTools).toEqual(['query_review_stats']);
    const blocks = artifact?.intentSkeleton?.blocks as Array<{ type: string }>;
    expect(blocks.map((b) => b.type)).toEqual(['stat-card', 'progress']);
  });

  it('无 artifact 时字段为 undefined', () => {
    const result = parseWithArtifact();
    expect(result.success).toBe(true);
    expect(result.skill?.artifact).toBeUndefined();
  });

  it('artifact 非对象 → 告警并丢弃，不阻断加载', () => {
    const result = parseWithArtifact('artifact: "not-an-object"');
    expect(result.success).toBe(true);
    expect(result.skill?.artifact).toBeUndefined();
    expect(result.warnings?.some((w) => w.includes('artifact'))).toBe(true);
  });

  it('layoutLock 非布尔 → 告警并丢弃该键', () => {
    const result = parseWithArtifact(
      'artifact:\n  layoutLock: "yes"\n  dataTools: [query_review_stats]',
    );
    expect(result.success).toBe(true);
    expect(result.skill?.artifact?.layoutLock).toBeUndefined();
    expect(result.skill?.artifact?.dataTools).toEqual(['query_review_stats']);
  });
});

describe('artifact 序列化 round-trip', () => {
  function roundTrip(skill: SkillDefinition) {
    const serialized = serializeSkillToMarkdown(
      {
        name: skill.name,
        description: skill.description,
        artifact: skill.artifact,
        preservedFrontmatter: skill.preservedFrontmatter,
      },
      skill.content,
    );
    return { serialized, reparsed: parseSkillFile(serialized, skill.sourcePath, skill.id, skill.location) };
  }

  it('artifact 经序列化后不丢失（KNOWN 键不进 preservedFrontmatter）', () => {
    const parsed = parseWithArtifact(ARTIFACT_YAML);
    expect(parsed.success).toBe(true);
    // 关键断言：artifact 已被识别为 KNOWN 键，不再进 preservedFrontmatter
    expect(parsed.skill?.preservedFrontmatter?.artifact).toBeUndefined();

    const { serialized, reparsed } = roundTrip(parsed.skill!);
    expect(serialized).toContain('artifact:');
    expect(reparsed.skill?.artifact?.layoutLock).toBe(true);
    expect(reparsed.skill?.artifact?.dataTools).toEqual(['query_review_stats']);
    const blocks = reparsed.skill?.artifact?.intentSkeleton?.blocks as Array<{ type: string }>;
    expect(blocks.map((b) => b.type)).toEqual(['stat-card', 'progress']);
  });

  it('无 artifact 时序列化不产出该键', () => {
    const parsed = parseWithArtifact();
    const { serialized } = roundTrip(parsed.skill!);
    expect(serialized).not.toContain('artifact:');
  });

  it('未知键与 artifact 共存时各自 round-trip', () => {
    const md = `---
name: weekly-report
description: 测试
${ARTIFACT_YAML}
my-custom-key: keep-me
---

正文。
`;
    const parsed = parseSkillFile(md, '/fixtures/w.md', 'weekly-report', 'global');
    expect(parsed.success).toBe(true);
    expect(parsed.skill?.preservedFrontmatter?.['my-custom-key']).toBe('keep-me');

    const { reparsed } = roundTrip(parsed.skill!);
    expect(reparsed.skill?.preservedFrontmatter?.['my-custom-key']).toBe('keep-me');
    expect(reparsed.skill?.artifact?.layoutLock).toBe(true);
  });
});

describe('validateArtifactSkeletonTypes', () => {
  it('已注册块类型 → 合法', () => {
    const result = validateArtifactSkeletonTypes(SKELETON);
    expect(result.valid).toBe(true);
    expect(result.unknownTypes).toEqual([]);
  });

  it('未注册块类型 → 列出 unknownTypes', () => {
    const result = validateArtifactSkeletonTypes({
      blocks: [{ type: 'stat-card' }, { type: 'nonexistent-widget' }],
    });
    expect(result.valid).toBe(false);
    expect(result.unknownTypes).toEqual(['nonexistent-widget']);
  });

  it('无 blocks 数组 → 合法（骨架可只声明 layout/meta）', () => {
    expect(validateArtifactSkeletonTypes({ layout: { mode: 'stack' } }).valid).toBe(true);
  });
});

describe('validateIntentAgainstSkeleton', () => {
  const artifact = (layoutLock: boolean): SkillArtifactDeclaration => ({
    intentSkeleton: SKELETON,
    layoutLock,
  });
  const intent = (types: string[]): GenerativeUIIntent => ({
    version: '1.1',
    blocks: types.map((type) => ({ type, props: {} })),
  } as GenerativeUIIntent);

  it('layoutLock：块序列完全一致 → 通过', () => {
    const result = validateIntentAgainstSkeleton(intent(['stat-card', 'progress']), artifact(true));
    expect(result.valid).toBe(true);
  });

  it('layoutLock：顺序不符 → 报错', () => {
    const result = validateIntentAgainstSkeleton(intent(['progress', 'stat-card']), artifact(true));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toEqual({
      code: 'block_mismatch',
      params: { index: 1, expected: 'stat-card', actual: 'progress' },
    });
  });

  it('layoutLock：块数不符 → 报错', () => {
    const result = validateIntentAgainstSkeleton(intent(['stat-card']), artifact(true));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toEqual({
      code: 'count_mismatch',
      params: { expected: 2, actual: 1 },
    });
  });

  it('非 layoutLock：骨架块全部出现即可（可补充）', () => {
    const result = validateIntentAgainstSkeleton(
      intent(['stat-card', 'text', 'progress']),
      artifact(false),
    );
    expect(result.valid).toBe(true);
  });

  it('非 layoutLock：缺骨架块 → 报错', () => {
    const result = validateIntentAgainstSkeleton(intent(['stat-card']), artifact(false));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toEqual({ code: 'missing_type', params: { type: 'progress' } });
  });

  it('骨架无 blocks → 恒通过', () => {
    const result = validateIntentAgainstSkeleton(intent(['text']), {
      intentSkeleton: { layout: { mode: 'stack' } },
    });
    expect(result.valid).toBe(true);
  });
});

describe('renderSkillContentWithArtifact', () => {
  it('有骨架时追加 artifact_template 段（含 skeletonRef 提示）', () => {
    const rendered = renderSkillContentWithArtifact({
      id: 'weekly-report',
      content: '# 正文',
      artifact: { intentSkeleton: SKELETON, layoutLock: true, dataTools: ['query_review_stats'] },
    });
    expect(rendered).toContain('# 正文');
    expect(rendered).toContain('<artifact_template skillId="weekly-report" layoutLock="true"');
    expect(rendered).toContain('dataTools="query_review_stats"');
    expect(rendered).toContain('"type": "stat-card"');
    expect(rendered).toContain('skeletonRef="weekly-report"');
    expect(rendered).toContain('</artifact_template>');
  });

  it('无 artifact 声明 → 原样返回', () => {
    expect(renderSkillContentWithArtifact({ id: 's', content: '# 正文' })).toBe('# 正文');
    expect(
      renderSkillContentWithArtifact({ id: 's', content: '# 正文', artifact: { layoutLock: true } }),
    ).toBe('# 正文');
  });
});

describe('findActiveArtifactSkill', () => {
  const skills: Record<string, Pick<SkillDefinition, 'id' | 'artifact'>> = {
    'weekly-report': { id: 'weekly-report', artifact: { intentSkeleton: SKELETON } },
    'other-skill': { id: 'other-skill' },
  };
  const getSkill = (id: string) => skills[id];

  it('skeletonRef 精确匹配', () => {
    const match = findActiveArtifactSkill([], getSkill, 'weekly-report');
    expect(match?.skillId).toBe('weekly-report');
  });

  it('skeletonRef 指向无骨架 skill → null', () => {
    expect(findActiveArtifactSkill([], getSkill, 'other-skill')).toBeNull();
    expect(findActiveArtifactSkill([], getSkill, 'missing')).toBeNull();
  });

  it('无 skeletonRef：唯一带骨架的激活 skill → 回退命中', () => {
    const match = findActiveArtifactSkill(['weekly-report', 'other-skill'], getSkill);
    expect(match?.skillId).toBe('weekly-report');
  });

  it('无 skeletonRef：多个带骨架 → 不猜测返回 null', () => {
    const multi: Record<string, Pick<SkillDefinition, 'id' | 'artifact'>> = {
      ...skills,
      'monthly-report': { id: 'monthly-report', artifact: { intentSkeleton: SKELETON } },
    };
    expect(
      findActiveArtifactSkill(['weekly-report', 'monthly-report'], (id) => multi[id]),
    ).toBeNull();
  });
});
