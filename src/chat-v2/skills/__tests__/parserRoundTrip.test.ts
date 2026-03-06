import { describe, expect, it } from 'vitest';
import { parseSkillFile, serializeSkillToMarkdown } from '../parser';

describe('skill parser round-trip', () => {
  it('preserves unknown frontmatter fields during parse and serialize', () => {
    const raw = `---
name: Test Skill
description: Test desc
allowed-tools:
  - builtin-web_search
x-extra-flag: true
custom-config:
  mode: strict
---

# body
`;

    const parsed = parseSkillFile(raw, '/tmp/SKILL.md', 'test-skill', 'global');
    expect(parsed.success).toBe(true);
    expect(parsed.skill?.allowedTools).toEqual(['builtin-web_search']);
    expect(parsed.skill?.preservedFrontmatter).toMatchObject({
      'x-extra-flag': true,
      'custom-config': { mode: 'strict' },
    });

    const serialized = serializeSkillToMarkdown(
      {
        name: parsed.skill!.name,
        description: parsed.skill!.description,
        allowedTools: parsed.skill!.allowedTools,
        preservedFrontmatter: parsed.skill!.preservedFrontmatter,
      },
      parsed.skill!.content,
    );

    expect(serialized).toContain('x-extra-flag: true');
    expect(serialized).toContain('custom-config:');
    expect(serialized).toContain('allowed-tools:');
  });
});
