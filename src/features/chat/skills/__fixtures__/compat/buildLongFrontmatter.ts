/**
 * Build SKILL.md fixtures that stress the bounded 64 KiB frontmatter limit.
 *
 * Padding uses an unknown `x-padding` key so description stays within the
 * ≤1024 validation limit while the raw frontmatter block approaches/exceeds
 * the parser's MAX_FRONTMATTER_LENGTH.
 */

const MAX_FRONTMATTER_LENGTH = 64 * 1024;

function buildFrontmatter(targetLength: number): string {
  const prefix = [
    'name: long-frontmatter-skill',
    'description: "Stress-test frontmatter length for AgentSkills-compatible hosts without exceeding the description character limit."',
    'license: MIT',
    'tags:',
    '  - stress',
    '  - frontmatter',
    'compatibility: Synthetic fixture for frontmatter length boundaries',
    'x-padding: "',
  ].join('\n');
  const suffix = '"';

  const fillLen = Math.max(0, targetLength - prefix.length - suffix.length);
  const padding = 'P'.repeat(fillLen);
  return `${prefix}${padding}${suffix}`;
}

function wrapSkill(frontmatter: string, body: string): string {
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}

/** Frontmatter payload length just under the parser limit. */
export function buildNearLimitSkillMarkdown(): string {
  let fm = buildFrontmatter(MAX_FRONTMATTER_LENGTH - 16);
  while (fm.length >= MAX_FRONTMATTER_LENGTH) {
    fm = buildFrontmatter(fm.length - 32);
  }
  if (fm.length < MAX_FRONTMATTER_LENGTH - 128) {
    fm = buildFrontmatter(MAX_FRONTMATTER_LENGTH - 16);
    while (fm.length >= MAX_FRONTMATTER_LENGTH) {
      fm = buildFrontmatter(fm.length - 8);
    }
  }
  return wrapSkill(
    fm,
    '# Long Frontmatter\n\nBody remains short; frontmatter is the stress target.'
  );
}

/** Frontmatter payload length over the parser limit. */
export function buildOversizedSkillMarkdown(): string {
  const fm = buildFrontmatter(MAX_FRONTMATTER_LENGTH + 256);
  if (fm.length <= MAX_FRONTMATTER_LENGTH) {
    throw new Error(
      `Expected oversized frontmatter > ${MAX_FRONTMATTER_LENGTH}, got ${fm.length}`
    );
  }
  return wrapSkill(
    fm,
    '# Oversized Frontmatter\n\nThis body should never be reached by a successful parse.'
  );
}

export const FRONTMATTER_LENGTH_LIMIT = MAX_FRONTMATTER_LENGTH;
