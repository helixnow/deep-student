import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key, i18n: { changeLanguage: vi.fn() } }),
  };
});

import * as chatV2 from '../../../../src/features/chat';
import * as skills from '../../../../src/features/chat/skills';

describe('skill legacy exports cleanup', () => {
  it('does not expose resource helper shims from chat-v2 root export', () => {
    expect('createResourceFromSkill' in chatV2).toBe(false);
    expect('isSkillContextRef' in chatV2).toBe(false);
  });

  it('does not expose skill context type helpers from skills index', () => {
    expect('skillInstructionDefinition' in skills).toBe(false);
    expect('createSkillInstructionBlocks' in skills).toBe(false);
  });
});
