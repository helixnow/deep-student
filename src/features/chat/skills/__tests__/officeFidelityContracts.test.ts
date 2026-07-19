import { describe, expect, it } from 'vitest';

import { officeFidelityToolsSkill } from '../builtin-tools/office-fidelity-tools';
import { docxToolsSkill } from '../builtin-tools/docx-tools';
import { pptxToolsSkill } from '../builtin-tools/pptx-tools';
import { xlsxToolsSkill } from '../builtin-tools/xlsx-tools';

describe('Office fidelity and secret prompt contracts', () => {
  it('publishes one strict read-only TaskObjectHandle preflight schema', () => {
    const tools = officeFidelityToolsSkill.embeddedTools ?? [];
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('builtin-office_fidelity_inspect');
    expect(tools[0].inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['source'],
    });
    expect(tools[0].description).toContain('office-fidelity-inspection/v1');
    expect(tools[0].description).toMatch(/supported\/preserved\/unsupported/);
  });

  it('covers the requested Office and PDF high-fidelity feature families', () => {
    expect(officeFidelityToolsSkill.content).toMatch(/宏、数字签名、修订、批注、域、脚注/);
    expect(officeFidelityToolsSkill.content).toMatch(/公式、命名范围、数据验证、图表、透视、外链/);
    expect(officeFidelityToolsSkill.content).toMatch(/母版、备注、动画/);
    expect(officeFidelityToolsSkill.content).toMatch(/PDF 表单\/签名\/附件\/加密/);
  });

  it('defaults macro/signature edits to refusal and never promises decryption', () => {
    expect(officeFidelityToolsSkill.content).toMatch(/默认拒绝自动编辑/);
    expect(officeFidelityToolsSkill.content).toContain('macro_policy=strip');
    expect(officeFidelityToolsSkill.content).toMatch(/签名失效/);
    expect(officeFidelityToolsSkill.content).toContain('DECRYPTOR_INTEGRATION_UNAVAILABLE');
    expect(officeFidelityToolsSkill.content).toMatch(/不得伪称已解密/);
  });

  it.each([
    ['docx', docxToolsSkill],
    ['xlsx', xlsxToolsSkill],
    ['pptx', pptxToolsSkill],
  ])('%s create/replace descriptions do not claim advanced-feature preservation', (_format, skill) => {
    const mutations = (skill.embeddedTools ?? []).filter(tool =>
      /_(create|replace_text)$/.test(tool.name),
    );
    expect(mutations.length).toBeGreaterThan(0);
    for (const tool of mutations) {
      expect(tool.description).not.toMatch(/保留宏|保留签名|完整保真/);
    }
  });
});
