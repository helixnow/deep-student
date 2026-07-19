import { describe, expect, it } from 'vitest';

import {
  CLAWHUB_READ_TOOL_NAMES,
  skillInstallerSkill,
} from '../builtin/skill-installer';

describe('skill-installer ClawHub tool exposure', () => {
  it('registers clawhub search/detail as allowedTools and embeddedTools', () => {
    expect(skillInstallerSkill.allowedTools).toEqual(
      expect.arrayContaining([...CLAWHUB_READ_TOOL_NAMES]),
    );
    const embeddedNames = (skillInstallerSkill.embeddedTools ?? []).map((t) => t.name);
    expect(embeddedNames).toEqual(
      expect.arrayContaining(['builtin-clawhub_search', 'builtin-clawhub_skill_detail']),
    );
    expect(embeddedNames).not.toContain('builtin-clawhub_download_and_scan');
    expect(embeddedNames).not.toContain('builtin-clawhub_verify');
  });

  it('guidance documents clawhub read tools and user confirmation for writes', () => {
    const content = skillInstallerSkill.content;
    expect(content).toContain('builtin-clawhub_search');
    expect(content).toContain('builtin-clawhub_skill_detail');
    expect(content).toMatch(/用户口头确认|用户确认/);
    expect(content).toContain('clawhub_download_and_scan');
    expect(content).not.toMatch(/web_fetch.*ClawHub 市场/);
  });

  it('embedded tool schemas stay read-only (no install flag)', () => {
    for (const tool of skillInstallerSkill.embeddedTools ?? []) {
      const props = tool.inputSchema?.properties ?? {};
      expect(props).not.toHaveProperty('install');
      expect(props).not.toHaveProperty('overwrite');
    }
  });
});
