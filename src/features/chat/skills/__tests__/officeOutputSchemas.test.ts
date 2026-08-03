import { describe, expect, it } from 'vitest';

import { docxToolsSkill } from '../builtin-tools/docx-tools';
import { pptxToolsSkill } from '../builtin-tools/pptx-tools';
import { xlsxToolsSkill } from '../builtin-tools/xlsx-tools';

describe('Office output target schemas', () => {
  for (const [format, skill] of [
    ['docx', docxToolsSkill],
    ['xlsx', xlsxToolsSkill],
    ['pptx', pptxToolsSkill],
  ] as const) {
    for (const action of ['create', 'replace_text']) {
      it(`${format}_${action} exposes hash-bound workspace delivery`, () => {
        const tool = skill.embeddedTools?.find(
          (candidate) => candidate.name === `builtin-${format}_${action}`,
        );
        expect(tool).toBeDefined();
        const properties = tool?.inputSchema?.properties as Record<string, any>;
        expect(properties.output_target.enum).toEqual(['vfs', 'workspace']);
        expect(properties.output_target.default).toBe('vfs');
        expect(properties.root_id.enum).toEqual(['workspace']);
        expect(properties.overwrite_policy.enum).toEqual(['fail', 'replace_if_match']);
        expect(properties.expected_sha256.type).toBe('string');
      });
    }
  }
});
