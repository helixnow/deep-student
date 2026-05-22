import { describe, expect, it } from 'vitest';

import { imageGenerationSkill } from '../builtin-tools';

describe('image generation skill contract', () => {
  it('depends on ask-user and documents semantic clarification flow', () => {
    expect(imageGenerationSkill.relatedSkills).toEqual(expect.arrayContaining(['ask-user']));
    expect(imageGenerationSkill.dependencies).toEqual(expect.arrayContaining(['ask-user']));
    expect(imageGenerationSkill.content).toContain('builtin-ask_user');
    expect(imageGenerationSkill.content).toContain('只问语义问题');
    expect(imageGenerationSkill.content).toContain('不要询问底层尺寸');
  });
});
