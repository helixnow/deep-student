import { describe, expect, it } from 'vitest';

import { builtinToolSkills, getBuiltinToolSkillById } from '../builtin-tools';
import { rolePacksSkill } from '../builtin-tools/role-packs';

describe('role packs contract', () => {
  it('registers a featured expert entry exactly once', () => {
    expect(getBuiltinToolSkillById('role-packs')).toBe(rolePacksSkill);
    expect(builtinToolSkills.filter((skill) => skill.id === 'role-packs')).toHaveLength(1);
    expect(rolePacksSkill.priority).toBeGreaterThanOrEqual(8);
  });

  it('covers every required role domain and composable workflow', () => {
    for (const domain of [
      'finance', 'legal', 'hr', 'operations', 'admin', 'research', 'teaching', 'content',
    ]) {
      expect(rolePacksSkill.description).toContain(domain);
    }
    for (const workflow of [
      'invoice reconcile', 'contract review', 'resume batch', 'mail merge', 'operations report',
    ]) {
      expect(rolePacksSkill.description).toContain(workflow);
    }
    expect(rolePacksSkill.content).toContain('人工终审');
    expect(rolePacksSkill.content).toContain('不要把旧版本静默升级');
  });

  it('exposes only list/get/validate with exact-version validation', () => {
    expect(rolePacksSkill.embeddedTools?.map((tool) => tool.name)).toEqual([
      'builtin-role_pack_list',
      'builtin-role_pack_get',
      'builtin-role_pack_validate',
    ]);
    const validate = rolePacksSkill.embeddedTools?.[2];
    expect(validate?.inputSchema.required).toEqual(['pack_id', 'version', 'inputs']);
    expect(validate?.inputSchema.properties.version.pattern).toBe('^[0-9]+\\.[0-9]+\\.[0-9]+$');
    expect(validate?.description).toContain('task provenance/audit manifest');
  });
});
