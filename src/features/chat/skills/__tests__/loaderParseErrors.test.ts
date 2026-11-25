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

import { loadSkillsFromFileSystem, reloadSkills } from '../loader';
import { skillRegistry } from '../registry';

describe('skill loader parse errors, declarative plugin skills, and reload concurrency', () => {
  beforeEach(() => {
    invokeMock.mockClear();
    skillRegistry.clear();
  });

  afterEach(() => {
    skillRegistry.clear();
    invokeMock.mockReset();
  });

  it('counts an individual SKILL.md parse failure', async () => {
    invokeMock.mockImplementation(async (command: string, args: { path: string }) => {
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
    });

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

  it('skips missing SKILL.md silently but counts real skill_read_file and directory IO errors', async () => {
    invokeMock.mockImplementation(async (command: string, args: { path?: string }) => {
      if (command === 'plugin:manager|declarative-skills') return [];
      if (command === 'skill_list_directories') {
        if (args.path === '/global-io-fail') {
          throw new Error(JSON.stringify({ code: 'IO_ERROR', message: 'Permission denied' }));
        }
        if (args.path?.endsWith('/.skills')) {
          return [
            { name: 'no-skill-md', path: `${args.path}/no-skill-md` },
            { name: 'unreadable-skill', path: `${args.path}/unreadable-skill` },
          ];
        }
        return [];
      }
      if (command === 'skill_read_file') {
        if (args.path?.includes('no-skill-md')) {
          throw JSON.stringify({ code: 'RESOURCE_NOT_FOUND', message: 'File not found' });
        }
        throw JSON.stringify({ code: 'IO_ERROR', message: 'stream did not contain valid UTF-8' });
      }
      throw new Error(`Unexpected invoke call: ${command}`);
    });

    const stats = await loadSkillsFromFileSystem({
      loadBuiltin: false,
      globalPath: '/global-io-fail',
      projectRootDir: '/test-project',
    });

    // 1 directory IO error (global) + 1 real file read error (unreadable-skill); missing SKILL.md is NOT an error.
    expect(stats.errors).toBe(2);
    expect(stats.total).toBe(0);
  });

  it('mounts declarative .dspack skills from Host as trusted plugin:// skills', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'plugin:manager|declarative-skills') {
        return [
          {
            pluginId: 'alice.kaoyan-pack',
            skillId: 'kaoyan-coach',
            name: '考研数学证明教练',
            description: '先列已知条件与待证目标',
            markdown: '---\nname: 考研数学证明教练\ndescription: 先列已知条件与待证目标\n---\n# 正文\n引导证明思路。',
            sourcePath: './skills/kaoyan-coach.md',
          },
        ];
      }
      if (command === 'skill_list_directories') return [];
      throw new Error(`Unexpected invoke call: ${command}`);
    });

    const stats = await reloadSkills({
      loadBuiltin: false,
      globalPath: null,
      projectRootDir: '/test-project',
    });

    expect(stats.errors).toBe(0);
    expect(stats.total).toBe(1);
    const mounted = skillRegistry.get('kaoyan-coach');
    expect(mounted).toMatchObject({
      id: 'kaoyan-coach',
      name: '考研数学证明教练',
      sourcePath: 'plugin://alice.kaoyan-pack/skills/kaoyan-coach.md',
      packageRoot: 'plugin://alice.kaoyan-pack',
      trustStatus: 'trusted',
    });
  });

  it('prevents overlapping reloadSkills calls from clearing mid-flight or overwriting newer skills with stale results', async () => {
    let releaseFirst!: (entries: Array<{ name: string; path: string }>) => void;
    let globalCall = 0;

    invokeMock.mockImplementation(async (command: string, args: { path?: string }) => {
      if (command === 'plugin:manager|declarative-skills') return [];
      if (command === 'skill_list_directories') {
        if (args.path === '/global-skills') {
          globalCall += 1;
          if (globalCall === 1) {
            // Older reload started before the custom skill was created; resolves slowly.
            return new Promise<Array<{ name: string; path: string }>>((resolve) => {
              releaseFirst = resolve;
            });
          }
          // Newer reload sees the freshly created custom skill immediately.
          return [{ name: 'my-custom-skill', path: '/global-skills/my-custom-skill' }];
        }
        return [];
      }
      if (command === 'skill_read_file') {
        return {
          path: args.path,
          content: '---\nname: My Custom Skill\ndescription: Freshly created\n---\nAlways verify proofs.',
        };
      }
      if (command === 'skill_list_package_files') {
        return [{ path: 'SKILL.md', size: 80 }];
      }
      throw new Error(`Unexpected invoke call: ${command}`);
    });

    // Seed an existing skill so we can prove reloadSkills does NOT wipe registry mid-flight.
    skillRegistry.register({
      id: 'existing-skill',
      name: 'Existing',
      description: 'Pre-existing skill',
      content: 'Body',
      location: 'global',
      sourcePath: '/global-skills/existing-skill/SKILL.md',
    });

    const firstReload = reloadSkills({ loadBuiltin: false, globalPath: '/global-skills', projectRootDir: '/test-project' });
    // Mid-flight: existing skill must STILL be present (no synchronous skillRegistry.clear()).
    expect(skillRegistry.get('existing-skill')).toBeDefined();

    const secondReload = reloadSkills({ loadBuiltin: false, globalPath: '/global-skills', projectRootDir: '/test-project' });
    const secondStats = await secondReload;
    expect(secondStats.global).toBe(1);
    expect(skillRegistry.get('my-custom-skill')).toBeDefined();
    expect(skillRegistry.get('existing-skill')).toBeUndefined();

    // Now the stale first reload finishes AFTER the second reload committed: it must NOT wipe my-custom-skill!
    releaseFirst([]);
    const firstStats = await firstReload;
    expect(firstStats.global).toBe(1);
    expect(skillRegistry.get('my-custom-skill')).toBeDefined();
  });
});
