import { describe, expect, it } from 'vitest';

import enSkills from '@/locales/en-US/skills.json';
import zhSkills from '@/locales/zh-CN/skills.json';

import { builtinSkills } from '../builtin';
import { builtinToolSkills } from '../builtin-tools';
import { browserToolsSkill } from '../builtin-tools/browser-tools';

describe('builtin skill localization', () => {
  const builtinSkillIds = [
    ...new Set([
      ...builtinSkills.map((skill) => skill.id),
      ...builtinToolSkills.map((skill) => skill.id),
      browserToolsSkill.id,
    ]),
  ];

  it.each([
    ['zh-CN', zhSkills.builtinNames],
    ['en-US', enSkills.builtinNames],
  ])('provides a display name for every builtin skill in %s', (_locale, names) => {
    const missingIds = builtinSkillIds.filter(
      (skillId) => !names[skillId as keyof typeof names]?.trim(),
    );

    expect(missingIds).toEqual([]);
  });

  // 414abdc7 landed both halves of the generative-ui localization (name +
  // description) in zh-CN and en-US. builtinDescriptions is intentionally not
  // required for every skill (getLocalizedSkillDescription falls back to the
  // skill's own description), so pin the generative-ui entries explicitly.
  it.each([
    ['zh-CN', zhSkills],
    ['en-US', enSkills],
  ])('localizes the generative-ui builtin name and description in %s', (_locale, skills) => {
    expect(skills.builtinNames['generative-ui']?.trim()).toBeTruthy();
    expect(skills.builtinDescriptions['generative-ui']?.trim()).toBeTruthy();
  });
});
