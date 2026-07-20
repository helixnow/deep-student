import { describe, expect, it } from 'vitest';

import {
  SKILL_MARKET_READ_TOOL_NAMES,
  skillInstallerSkill,
} from '../builtin/skill-installer';

describe('skill-installer SkillMarket tool exposure', () => {
  it('registers skill_market search/detail as allowedTools and embeddedTools', () => {
    expect(skillInstallerSkill.allowedTools).toEqual(
      expect.arrayContaining([...SKILL_MARKET_READ_TOOL_NAMES]),
    );
    const embeddedNames = (skillInstallerSkill.embeddedTools ?? []).map((t) => t.name);
    expect(embeddedNames).toEqual(
      expect.arrayContaining(['builtin-skill_market_search', 'builtin-skill_market_skill_detail']),
    );
    expect(embeddedNames).not.toContain('builtin-skill_market_download_and_scan');
    expect(embeddedNames).not.toContain('builtin-skill_market_verify');
  });

  it('guidance documents skill_market read tools and user confirmation for writes', () => {
    const content = skillInstallerSkill.content;
    expect(content).toContain('builtin-skill_market_search');
    expect(content).toContain('builtin-skill_market_skill_detail');
    expect(content).toMatch(/用户口头确认|用户确认/);
    expect(content).toContain('skill_market_download_and_scan');
    expect(content).not.toMatch(/web_fetch.*SkillMarket 市场/);
  });

  it('embedded tool schemas stay read-only (no install flag)', () => {
    for (const tool of skillInstallerSkill.embeddedTools ?? []) {
      const props = tool.inputSchema?.properties ?? {};
      expect(props).not.toHaveProperty('install');
      expect(props).not.toHaveProperty('overwrite');
    }
  });
});
