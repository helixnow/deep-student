import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import { getSkillTrustOverride, setSkillTrustOverride } from '../skillTrustStorage';
import type { SkillDefinition } from '../types';

const skill: SkillDefinition = {
  id: 'external-tools',
  name: 'external-tools',
  description: 'External tools',
  version: '1.0.0',
  content: '---\nname: external-tools\n---\nBody',
  location: 'global',
  sourcePath: '/tmp/skills/external-tools/SKILL.md',
  packageRoot: '/tmp/skills/external-tools',
  trustStatus: 'untrusted',
  embeddedTools: [],
};

describe('backend-authoritative skill trust', () => {
  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ trusted: true, package_sha256: 'a'.repeat(64) });
  });

  it('persists backend trust before updating the local UI state', async () => {
    await setSkillTrustOverride(skill.id, 'trusted', skill);

    expect(invokeMock).toHaveBeenCalledWith('chat_v2_set_skill_trust', {
      skillId: skill.id,
      packageRoot: skill.packageRoot,
      trusted: true,
    });
    expect(getSkillTrustOverride(skill.id)).toBe('trusted');
  });

  it('does not claim local trust when backend verification fails', async () => {
    invokeMock.mockRejectedValueOnce(new Error('package hash mismatch'));

    await expect(setSkillTrustOverride(skill.id, 'trusted', skill)).rejects.toThrow(
      'package hash mismatch',
    );
    expect(getSkillTrustOverride(skill.id)).toBeNull();
  });

  it('revokes backend trust before marking the package untrusted locally', async () => {
    await setSkillTrustOverride(skill.id, 'trusted', skill);
    await setSkillTrustOverride(skill.id, 'untrusted', skill);

    expect(invokeMock).toHaveBeenLastCalledWith('chat_v2_set_skill_trust', {
      skillId: skill.id,
      packageRoot: skill.packageRoot,
      trusted: false,
    });
    expect(getSkillTrustOverride(skill.id)).toBe('untrusted');
  });
});
