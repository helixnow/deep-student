import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (command: string, args: { path: string }) => {
    if (command === 'skill_list_directories') {
      return args.path.endsWith('/.skills')
        ? [{ name: 'broken-skill', path: `${args.path}/broken-skill` }]
        : [];
    }
    if (command === 'skill_read_file') {
      return {
        path: args.path,
        content: [
          '---',
          'name: broken-skill',
          'description: Broken loader regression fixture',
          '---not-a-closing-delimiter',
          '# body',
        ].join('\n'),
      };
    }
    throw new Error(`Unexpected invoke call: ${command}`);
  }),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import { loadSkillsFromFileSystem } from '../loader';
import { skillRegistry } from '../registry';

describe('skill loader parse errors', () => {
  beforeEach(() => {
    invokeMock.mockClear();
    skillRegistry.clear();
  });

  afterEach(() => {
    skillRegistry.clear();
  });

  it('counts an individual SKILL.md parse failure', async () => {
    const stats = await loadSkillsFromFileSystem({
      loadBuiltin: false,
      globalPath: null,
      projectRootDir: '/test-project',
    });

    expect(stats).toMatchObject({
      project: 0,
      errors: 1,
      total: 0,
    });
    expect(skillRegistry.get('broken-skill')).toBeUndefined();
  });
});
