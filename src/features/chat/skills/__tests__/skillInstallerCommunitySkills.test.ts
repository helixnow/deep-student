import { describe, expect, it } from 'vitest';

import {
  SKILL_MARKET_INSTALL_TOOL_NAMES,
  SKILL_MARKET_READ_TOOL_NAMES,
  skillInstallerSkill,
} from '../builtin/skill-installer';

describe('skill-installer SkillMarket tool exposure', () => {
  it('registers the complete governed marketplace workflow', () => {
    expect(skillInstallerSkill.allowedTools).toEqual(
      expect.arrayContaining([
        ...SKILL_MARKET_READ_TOOL_NAMES,
        ...SKILL_MARKET_INSTALL_TOOL_NAMES,
      ]),
    );
    const embeddedNames = (skillInstallerSkill.embeddedTools ?? []).map((t) => t.name);
    expect(embeddedNames).toEqual(
      expect.arrayContaining([
        'builtin-skill_market_search',
        'builtin-skill_market_skill_detail',
        'builtin-skill_market_verify',
        'builtin-skill_market_download_and_scan',
      ]),
    );
  });

  it('guidance uses the platform approval card instead of duplicate confirmation', () => {
    const content = skillInstallerSkill.content;
    expect(content).toContain('builtin-skill_market_search');
    expect(content).toContain('builtin-skill_market_skill_detail');
    expect(content).toContain('builtin-skill_market_download_and_scan');
    expect(content).toContain('平台审批卡');
    expect(content).not.toContain('用户口头确认后');
    expect(content).not.toMatch(/web_fetch.*SkillMarket 市场/);
  });

  it('download schema freezes the scan artifact at the install boundary', () => {
    const tool = (skillInstallerSkill.embeddedTools ?? []).find(
      (candidate) => candidate.name === 'builtin-skill_market_download_and_scan',
    );
    expect(tool?.inputSchema?.properties).toHaveProperty('install');
    expect(tool?.inputSchema?.properties).toHaveProperty('expectedPackageSha256');
    expect(tool?.inputSchema?.properties).toHaveProperty('tempZipPath');
    expect(tool?.inputSchema?.properties).toHaveProperty('declaredRiskLevel');
  });
});
