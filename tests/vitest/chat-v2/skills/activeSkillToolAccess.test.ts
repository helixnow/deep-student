import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('i18next', () => ({
  default: {
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  },
}));

vi.mock('@/chat-v2/skills/resourceHelper', () => ({
  createResourceFromSkill: vi.fn(),
}));

import { createSkillActions } from '@/chat-v2/core/store/skillActions';
import type { ChatStoreState, GetState, SetState } from '@/chat-v2/core/store/types';
import { skillRegistry } from '@/chat-v2/skills/registry';
import { clearSessionSkills, getLoadedToolSchemas } from '@/chat-v2/skills/progressiveDisclosure';
import { SKILL_INSTRUCTION_TYPE_ID } from '@/chat-v2/skills/types';
import { createResourceFromSkill } from '@/chat-v2/skills/resourceHelper';

const SESSION_ID = 'session-active-skill-tools';

describe('Active skills tool access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    skillRegistry.clear();
    clearSessionSkills(SESSION_ID);
  });

  afterEach(() => {
    skillRegistry.clear();
    clearSessionSkills(SESSION_ID);
  });

  it('auto-loads embedded tools when a skill is activated', async () => {
    const testSkill = {
      id: 'test-skill',
      name: 'test-skill',
      description: 'skill used for tool activation test',
      content: 'instructions',
      sourcePath: 'tests/skills/test-skill.md',
      location: 'builtin',
      embeddedTools: [
        {
          name: 'test_tool',
          description: 'tool for active skill',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
            },
            required: ['query'],
          },
        },
      ],
    };

    skillRegistry.register(testSkill);

    vi.mocked(createResourceFromSkill).mockImplementation(async (skill) => ({
      resourceId: `skill_${skill.id}`,
      hash: 'hash',
      typeId: SKILL_INSTRUCTION_TYPE_ID,
      isSticky: true,
      displayName: skill.name,
      skillId: skill.id,
    }));

    const state = {
      sessionId: SESSION_ID,
      pendingContextRefs: [],
      activeSkillIds: [],
      removeContextRef: vi.fn(),
      clearContextRefs: vi.fn(),
    } as unknown as ChatStoreState;

    const set: SetState = (update) => {
      const patch =
        typeof update === 'function' ? update(state as ChatStoreState) : update;
      Object.assign(state as ChatStoreState, patch);
    };
    const get: GetState = () => state as never;

    const actions = createSkillActions(set, get);
    const activated = await actions.activateSkill('test-skill');

    expect(activated).toBe(true);
    expect(state.activeSkillIds).toContain('test-skill');
    expect(state.pendingContextRefs.some((ref) => ref.skillId === 'test-skill')).toBe(true);

    const loadedTools = getLoadedToolSchemas(SESSION_ID);
    expect(loadedTools.map((tool) => tool.name)).toContain('test_tool');
  });
});
