import { describe, expect, it } from 'vitest';

import { builtinSkills, courseStudySkill } from '../builtin';
import * as builtinToolModules from '../builtin-tools';

describe('course-study builtin skill', () => {
  it('is registered as an on-demand composite skill', () => {
    expect(builtinSkills.some((skill) => skill.id === 'course-study')).toBe(true);
    expect(courseStudySkill.skillType).toBe('composite');
    expect(courseStudySkill.disableAutoInvoke).toBe(false);
    // 不新增工具：只复用检索 / 读取工具组
    expect(courseStudySkill.embeddedTools ?? []).toEqual([]);
    expect(courseStudySkill.dependencies).toEqual(
      expect.arrayContaining(['knowledge-retrieval', 'learning-resource']),
    );
  });

  it('stays out of the builtin tool-group token budget set', () => {
    const toolSkillIds = Object.values(builtinToolModules)
      .filter((value): value is { id: string } =>
        typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string')
      .map((value) => value.id);
    expect(toolSkillIds).not.toContain('course-study');
  });

  it('carries the retrieval discipline, time-range read and citation rules', () => {
    const { content } = courseStudySkill;
    expect(content).toContain('builtin-unified_search');
    expect(content).toContain('resource_ids');
    expect(content).toContain('关键词');
    expect(content).toContain('换说法');
    expect(content).toContain('time_start');
    expect(content).toContain('time_end');
    expect(content).toContain('[媒体@{resource_id}:{mm:ss}]');
    expect(content).toContain('以图为准');
    expect(content).toContain('builtin-chatanki_run');
    expect(content).toContain('reference_file_ids');
  });

  it('keeps the injected instructions compact', () => {
    // 按需注入，但仍应保持精简（≈ chars/4 估算 < 600 tokens）
    expect(courseStudySkill.content.length).toBeLessThan(2400);
  });
});
