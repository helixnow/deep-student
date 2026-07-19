import { describe, expect, it } from 'vitest';

import {
  browserToolsSkill,
  filterBuiltinToolSkillsForPlatform,
} from '../builtin-tools';
import { webFetchSkill } from '../builtin-tools/web-fetch';

describe('browser-tools platform registration', () => {
  const skills = [webFetchSkill, browserToolsSkill];

  it.each(['windows', 'macos'])('keeps browser Agent tools on %s', (platform) => {
    expect(filterBuiltinToolSkillsForPlatform(skills, platform)).toEqual(skills);
  });

  it.each(['linux', 'android', 'unknown'])(
    'does not advertise browser Agent tools on %s',
    (platform) => {
      const filtered = filterBuiltinToolSkillsForPlatform(skills, platform);
      expect(filtered).toEqual([webFetchSkill]);
      expect(filtered.some((skill) => skill.id === 'browser-tools')).toBe(false);
    },
  );
});
