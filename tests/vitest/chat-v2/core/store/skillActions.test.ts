import { describe, expect, it, vi } from 'vitest';

import { createSkillActions } from '@/chat-v2/core/store/skillActions';
import type { ChatStoreState, GetState, SetState } from '@/chat-v2/core/store/types';

vi.mock('@/chat-v2/skills/registry', () => ({
  skillRegistry: {
    get: (id: string) =>
      id === 'deep-student'
        ? {
            id: 'deep-student',
            name: '深度学者',
            embeddedTools: [],
            dependencies: [],
          }
        : undefined,
  },
}));

vi.mock('@/chat-v2/skills/progressiveDisclosure', () => ({
  loadSkillsToSession: vi.fn(() => ({ loaded: [], alreadyLoaded: [], notFound: [] })),
  isSkillLoaded: vi.fn(() => false),
  unloadSkill: vi.fn(),
}));

function createHarness(initialState: Partial<ChatStoreState> = {}) {
  let state = {
    sessionId: 'sess-skill-actions',
    pendingContextRefs: [],
    activeSkillIds: [],
    skillStateJson: null,
    removeContextRef: vi.fn(),
    clearContextRefs: vi.fn(),
    ...initialState,
  } as unknown as ChatStoreState & {
    removeContextRef: (resourceId: string) => void;
    clearContextRefs: (typeId?: string) => void;
  };

  const set: SetState = (partial) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch };
  };
  const get: GetState = () => state as ReturnType<GetState>;

  return {
    actions: createSkillActions(set, get),
    getState: () => state,
  };
}

describe('skillActions structured state priority', () => {
  it('hasActiveSkill returns true from structured skill state without refs', () => {
    const { actions } = createHarness({
      skillStateJson: JSON.stringify({ manualPinnedSkillIds: ['deep-student'], version: 3 }),
      activeSkillIds: [],
      pendingContextRefs: [],
    });

    expect(actions.hasActiveSkill()).toBe(true);
  });

  it('repairSkillState syncs activeSkillIds from structured skill state without refs', () => {
    const { actions, getState } = createHarness({
      skillStateJson: JSON.stringify({ manualPinnedSkillIds: ['deep-student'], version: 3 }),
      activeSkillIds: [],
      pendingContextRefs: [],
    });

    actions.repairSkillState();

    expect(getState().activeSkillIds).toEqual(['deep-student']);
  });

  it('deactivateSkill clears active ids even when no skill ref exists', () => {
    const { actions, getState } = createHarness({
      activeSkillIds: ['deep-student'],
      pendingContextRefs: [],
      skillStateJson: JSON.stringify({ manualPinnedSkillIds: ['deep-student'], version: 3 }),
    });

    actions.deactivateSkill('deep-student');

    expect(getState().activeSkillIds).toEqual([]);
    expect(JSON.parse(getState().skillStateJson ?? '{}')).toMatchObject({
      manualPinnedSkillIds: [],
      version: 4,
    });
  });

  it('activateSkill writes manualPinnedSkillIds immediately', async () => {
    const { actions, getState } = createHarness({
      activeSkillIds: [],
      pendingContextRefs: [],
      skillStateJson: null,
    });

    const result = await actions.activateSkill('deep-student');

    expect(result).toBe(true);
    expect(getState().activeSkillIds).toEqual(['deep-student']);
    expect(JSON.parse(getState().skillStateJson ?? '{}')).toMatchObject({
      manualPinnedSkillIds: ['deep-student'],
      version: 1,
    });
  });
});
