import { describe, expect, it } from 'vitest';

import { validateSkillMetadata } from '../types';

describe('skill metadata dependencies validation', () => {
  it('rejects non-array dependencies', () => {
    const result = validateSkillMetadata({
      id: 'test-skill',
      name: 'test-skill',
      description: 'x'.repeat(60),
      dependencies: 'knowledge-retrieval' as unknown as string[],
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('dependencies 必须是字符串数组');
  });

  it('rejects dependencies with non-string entries', () => {
    const result = validateSkillMetadata({
      id: 'test-skill',
      name: 'test-skill',
      description: 'x'.repeat(60),
      dependencies: ['knowledge-retrieval', 123 as unknown as string],
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('dependencies 数组中的每个元素必须是字符串');
  });

  it('warns when standalone skill declares dependencies', () => {
    const result = validateSkillMetadata({
      id: 'test-skill',
      name: 'test-skill',
      description: 'x'.repeat(60),
      skillType: 'standalone',
      dependencies: ['knowledge-retrieval'],
    });

    expect(result.valid).toBe(true);
    expect(result.warnings).toContain('dependencies 通常用于 composite 技能，当前 skillType 不是 composite');
  });
});
