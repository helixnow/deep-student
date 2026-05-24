import { describe, expect, it } from 'vitest';

import type { SkillDefinition } from '../types';
import { applyCustomizationToSkill } from '../builtinStorage';

describe('builtin skill customization metadata parity', () => {
  it('applies skillType/relatedSkills/dependencies to builtin skills', () => {
    const original: SkillDefinition = {
      id: 'deep-student',
      name: '深度学者',
      description: 'desc',
      version: '1.0.0',
      author: 'Deep Student',
      priority: 3,
      disableAutoInvoke: false,
      location: 'builtin',
      sourcePath: 'builtin://deep-student',
      isBuiltin: true,
      content: '# content',
      skillType: 'standalone',
      relatedSkills: ['knowledge-retrieval'],
      dependencies: ['vfs-memory'],
    };

    const customized = applyCustomizationToSkill(original, {
      skillType: 'composite',
      relatedSkills: ['knowledge-retrieval', 'ask-user'],
      dependencies: ['knowledge-retrieval', 'vfs-memory', 'ask-user'],
    });

    expect(customized.skillType).toBe('composite');
    expect(customized.relatedSkills).toEqual(['knowledge-retrieval', 'ask-user']);
    expect(customized.dependencies).toEqual(['knowledge-retrieval', 'vfs-memory', 'ask-user']);
  });
});
