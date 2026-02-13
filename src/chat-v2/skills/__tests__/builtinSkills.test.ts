import { describe, expect, it } from 'vitest';

import { builtinSkills, deepScholarSkill } from '../builtin';

describe('builtin skill registration', () => {
  it('includes deep-student in builtinSkills', () => {
    expect(builtinSkills.some(skill => skill.id === 'deep-student')).toBe(true);
    expect(deepScholarSkill.dependencies).toEqual(expect.arrayContaining(['knowledge-retrieval', 'vfs-memory', 'ask-user']));
  });
});
