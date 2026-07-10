import { describe, expect, it } from 'vitest';

import {
  getSkillPackageSource,
  getSkillTrustStatus,
} from '../packageMetadata';

describe('getSkillTrustStatus (fail-closed)', () => {
  it('keeps builtin skills trusted via location', () => {
    expect(getSkillTrustStatus('builtin', 'builtin://memory')).toBe('builtin');
  });

  it('keeps builtin skills trusted via builtin:// sourcePath even if location is global', () => {
    expect(getSkillTrustStatus('global', 'builtin://workspace-tools')).toBe('builtin');
    expect(getSkillPackageSource('global', 'builtin://workspace-tools')).toBe('builtin');
  });

  it('treats external compatibility dirs as untrusted', () => {
    expect(
      getSkillTrustStatus('project', '/repo/.agents/skills/foo/SKILL.md'),
    ).toBe('untrusted');
    expect(
      getSkillTrustStatus('project', 'C:\\Users\\x\\.claude\\skills\\bar\\SKILL.md'),
    ).toBe('untrusted');
  });

  it('defaults global skills without provenance marker to untrusted', () => {
    expect(
      getSkillTrustStatus('global', '/home/u/.deep-student/skills/my-skill/SKILL.md', [
        { path: 'SKILL.md', kind: 'entry' },
      ]),
    ).toBe('untrusted');
  });

  it('defaults project skills without marker to untrusted', () => {
    expect(
      getSkillTrustStatus('project', '/repo/.skills/spss/SKILL.md', [
        { path: 'SKILL.md', kind: 'entry' },
        { path: 'references/example.md', kind: 'reference' },
      ]),
    ).toBe('untrusted');
  });

  it('treats agent-installed marker skills as untrusted', () => {
    expect(
      getSkillTrustStatus('global', '/home/u/.deep-student/skills/agent-skill/SKILL.md', [
        { path: 'SKILL.md', kind: 'entry' },
        { path: 'AGENT_INSTALLED.json', kind: 'other' },
      ]),
    ).toBe('untrusted');
  });
});
