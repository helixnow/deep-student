import { describe, expect, it, vi } from 'vitest';

import { createSkillActions } from '@/features/chat/core/store/skillActions';
import type { ChatStoreState, GetState, SetState } from '@/features/chat/core/store/types';

const mocks = vi.hoisted(() => ({
  notify: vi.fn(),
  translate: vi.fn((key: string, params?: Record<string, unknown>) =>
    `${key}:${String(params?.skillId ?? '')}`),
}));

vi.mock('i18next', () => ({
  default: {
    t: (...args: [string, Record<string, unknown>?]) => mocks.translate(...args),
  },
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: (...args: unknown[]) => mocks.notify(...args),
}));

vi.mock('@/features/chat/skills/registry', () => ({
  skillRegistry: {
    get: (id: string) =>
      id === 'deep-student'
        ? {
            id: 'deep-student',
            name: '深度学者',
            embeddedTools: [],
            dependencies: [],
          }
        : id === 'external-skill'
          ? {
              id: 'external-skill',
              name: 'External skill',
              description: 'External skill',
              content: '',
              version: '1.0.0',
              location: 'external',
              sourcePath: '/tmp/external-skill/SKILL.md',
              trustStatus: 'untrusted',
              embeddedTools: [],
              dependencies: [],
            }
        : id === 'parent-missing'
          ? {
              id: 'parent-missing',
              name: 'Parent missing',
              description: 'Parent missing',
              content: '',
              version: '1.0.0',
              location: 'builtin',
              sourcePath: 'builtin://parent-missing',
              trustStatus: 'builtin',
              embeddedTools: [],
              dependencies: ['missing-dependency'],
            }
        : undefined,
  },
}));

vi.mock('@/features/chat/skills/progressiveDisclosure', () => ({
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

  it('localizes rejected activation from admission code and params', async () => {
    const { actions } = createHarness();

    await expect(actions.activateSkill('external-skill')).resolves.toBe(false);

    expect(mocks.translate).toHaveBeenCalledWith(
      'skills:errors.runtimeAdmission.untrusted',
      expect.objectContaining({ skillId: 'external-skill' }),
    );
    expect(mocks.notify).toHaveBeenCalledWith(
      'warning',
      'skills:errors.runtimeAdmission.untrusted:external-skill',
    );
  });

  it('localizes unavailable dependency failures before activation', async () => {
    const { actions, getState } = createHarness();

    await expect(actions.activateSkill('parent-missing')).resolves.toBe(false);

    expect(mocks.translate).toHaveBeenCalledWith(
      'skills:errors.runtimeAdmission.dependency_unavailable',
      expect.objectContaining({
        skillId: 'parent-missing',
        dependencyId: 'missing-dependency',
        reason: 'missing',
      }),
    );
    expect(getState().activeSkillIds).toEqual([]);
  });
});
