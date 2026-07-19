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

  it('exposes controlled file bridge tools without a raw path parameter', () => {
    const upload = browserToolsSkill.embeddedTools?.find(
      (tool) => tool.name === 'builtin-browser_file_upload',
    );
    const downloads = browserToolsSkill.embeddedTools?.find(
      (tool) => tool.name === 'builtin-browser_downloads',
    );

    expect(upload).toBeDefined();
    expect(downloads).toBeDefined();
    expect(upload?.inputSchema.properties).not.toHaveProperty('path');
    expect(upload?.inputSchema.properties).not.toHaveProperty('absolute_path');
    expect(upload?.inputSchema.properties.files.items.properties).toEqual(
      expect.objectContaining({
        root_id: expect.any(Object),
        relative_path: expect.any(Object),
      }),
    );
    expect(upload?.description).toContain('不会自动提交表单');
  });
});
