import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// 完整覆盖 i18next 表面：产品模块图谱中 src/i18n.ts 会在模块加载时执行
// `i18n.use(...).init(...)` 与 `i18n.on('languageChanged', ...)`，只 mock `t`
// 会让本文件在收集阶段就崩溃（default.use is not a function）。
vi.mock('i18next', () => {
  const t = (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key;
  const i18nMock = {
    t,
    isInitialized: true,
    language: 'zh-CN',
    use: () => i18nMock,
    init: () => Promise.resolve(t),
    on: () => i18nMock,
    off: () => i18nMock,
    addResourceBundle: () => i18nMock,
    hasResourceBundle: () => true,
    loadNamespaces: () => Promise.resolve(),
    changeLanguage: () => Promise.resolve(t),
  };
  return { default: i18nMock };
});

import { createSkillActions } from '@/features/chat/core/store/skillActions';
import type { ChatStoreState, GetState, SetState } from '@/features/chat/core/store/types';
import { skillRegistry } from '@/features/chat/skills/registry';
import { clearSessionSkills, getLoadedToolSchemas } from '@/features/chat/skills/progressiveDisclosure';

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
    expect(state.pendingContextRefs).toEqual([]);

    const loadedTools = getLoadedToolSchemas(SESSION_ID);
    expect(loadedTools.map((tool) => tool.name)).toContain('test_tool');
  });
});
