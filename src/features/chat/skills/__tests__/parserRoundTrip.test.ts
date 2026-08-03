import { describe, expect, it } from 'vitest';
import { parseSkillFile, serializeSkillToMarkdown } from '../parser';

describe('skill parser round-trip', () => {
  it('preserves unknown frontmatter fields during parse and serialize', () => {
    const raw = `---
name: Test Skill
description: Test desc
manifest-version: "2"
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
    expect(parsed.skill?.manifestVersion).toBe('2');
    expect(parsed.skill?.preservedFrontmatter).toMatchObject({
      'x-extra-flag': true,
      'custom-config': { mode: 'strict' },
    });

    const serialized = serializeSkillToMarkdown(
      {
        name: parsed.skill!.name,
        description: parsed.skill!.description,
        manifestVersion: parsed.skill!.manifestVersion,
        allowedTools: parsed.skill!.allowedTools,
        preservedFrontmatter: parsed.skill!.preservedFrontmatter,
      },
      parsed.skill!.content,
    );

    expect(serialized).toContain('x-extra-flag: true');
    expect(serialized).toContain('custom-config:');
    expect(serialized).toContain('allowed-tools:');
    expect(serialized).toContain('manifest-version:');
  });

  it('preserves top-level oneOf constraints in embedded tool schemas', () => {
    const raw = `---
name: Strict Selector
description: Requires exactly one selector
embedded-tools:
  - name: builtin-strict_selector
    description: Select by document or cards
    inputSchema:
      type: object
      properties:
        documentId:
          type: string
        cardIds:
          type: array
          items:
            type: string
      oneOf:
        - required: [documentId]
        - required: [cardIds]
      additionalProperties: false
---

# body
`;

    const parsed = parseSkillFile(raw, '/tmp/SKILL.md', 'strict-selector', 'global');

    expect(parsed.success).toBe(true);
    expect(parsed.skill?.embeddedTools?.[0]?.inputSchema.oneOf).toEqual([
      { required: ['documentId'] },
      { required: ['cardIds'] },
    ]);
  });

  it('round-trips retemplate selectors and schema-valued version maps', () => {
    const raw = `---
name: Retemplate Cards
description: Change templates with optimistic locking
embedded-tools:
  - name: builtin-chatanki_retemplate
    description: Retemplate a document or selected cards
    inputSchema:
      type: object
      properties:
        documentId:
          type: string
          minLength: 1
        cardIds:
          type: array
          uniqueItems: true
          items:
            type: string
            minLength: 1
        targetTemplateId:
          type: string
          minLength: 1
        strategy:
          type: string
          enum: [map_only, fill_missing]
        expectedVersions:
          type: object
          minProperties: 1
          additionalProperties:
            type: string
            minLength: 1
      required: [targetTemplateId, strategy, expectedVersions]
      oneOf:
        - required: [documentId]
        - required: [cardIds]
      additionalProperties: false
---

# body
`;

    const firstParse = parseSkillFile(raw, '/tmp/SKILL.md', 'retemplate-cards', 'global');
    expect(firstParse.success).toBe(true);

    const serialized = serializeSkillToMarkdown(
      {
        name: firstParse.skill!.name,
        description: firstParse.skill!.description,
        embeddedTools: firstParse.skill!.embeddedTools,
      },
      firstParse.skill!.content,
    );
    const secondParse = parseSkillFile(
      serialized,
      '/tmp/ROUND_TRIP_SKILL.md',
      'retemplate-cards',
      'global',
    );
    const schema = secondParse.skill?.embeddedTools?.[0]?.inputSchema;
    const expectedVersions = schema?.properties.expectedVersions;

    expect(secondParse.success).toBe(true);
    expect(schema?.oneOf).toEqual([
      { required: ['documentId'] },
      { required: ['cardIds'] },
    ]);
    expect(expectedVersions?.minProperties).toBe(1);
    expect(schema?.properties.documentId?.minLength).toBe(1);
    expect(schema?.properties.cardIds?.uniqueItems).toBe(true);
    expect(schema?.properties.cardIds?.items?.minLength).toBe(1);
    expect(schema?.properties.targetTemplateId?.minLength).toBe(1);
    expect(expectedVersions?.additionalProperties).toEqual({
      type: 'string',
      minLength: 1,
    });
  });
});
