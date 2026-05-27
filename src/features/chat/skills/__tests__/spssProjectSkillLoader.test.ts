import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PROJECT_ROOT = path.resolve(process.cwd());
const PROJECT_SKILLS_ROOT = path.join(PROJECT_ROOT, '.skills');

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (command: string, args: { path: string }) => {
    if (command === 'skill_list_directories' && args.path === PROJECT_SKILLS_ROOT) {
      return [
        {
          name: 'spss-paper-analysis',
          path: path.join(PROJECT_SKILLS_ROOT, 'spss-paper-analysis'),
        },
        {
          name: 'statistics-tools',
          path: path.join(PROJECT_SKILLS_ROOT, 'statistics-tools'),
        },
      ];
    }

    if (command === 'skill_read_file') {
      return {
        path: args.path,
        content: readFileSync(args.path, 'utf8'),
      };
    }

    throw new Error(`Unexpected invoke call: ${command} ${JSON.stringify(args)}`);
  }),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import { loadSkillsFromFileSystem } from '../loader';
import { skillRegistry } from '../registry';

describe('SPSS project skill loader', () => {
  beforeEach(() => {
    invokeMock.mockClear();
    skillRegistry.clear();
  });

  afterEach(() => {
    skillRegistry.clear();
  });

  it('loads the SPSS project skills from the .skills directory', async () => {
    const stats = await loadSkillsFromFileSystem({
      loadBuiltin: false,
      globalPath: null,
      projectPath: '.skills',
      projectRootDir: PROJECT_ROOT,
    });

    expect(stats.errors).toBe(0);
    expect(stats.project).toBe(2);
    expect(stats.total).toBe(2);

    const mainSkill = skillRegistry.get('spss-paper-analysis');
    const toolSkill = skillRegistry.get('statistics-tools');

    expect(mainSkill?.location).toBe('project');
    expect(toolSkill?.location).toBe('project');
    expect(mainSkill?.name).toBe('SPSS 论文分析');
    expect(toolSkill?.embeddedTools?.map((tool) => tool.name)).toEqual([
      'mcp_stats_inspect_dataset',
      'mcp_stats_run_analysis',
      'mcp_stats_explain_result',
      'mcp_stats_export_tables',
    ]);
  });
});
