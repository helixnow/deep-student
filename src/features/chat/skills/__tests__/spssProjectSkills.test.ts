import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseSkillFile } from '../parser';
import {
  clearSessionSkills,
  getLoadedToolSchemas,
  handleLoadSkillsToolCall,
} from '../progressiveDisclosure';
import { skillRegistry } from '../registry';
import { validateSkillMetadata } from '../types';

const PROJECT_ROOT = path.resolve(process.cwd());
const SESSION_ID = 'session-spss-project-skills';

const askUserSkill = {
  id: 'ask-user',
  name: 'ask-user',
  description: 'Question asking helper for SPSS skill tests.',
  content: 'ask user helper',
  sourcePath: 'tests://ask-user',
  location: 'builtin' as const,
  skillType: 'standalone' as const,
  embeddedTools: [
    {
      name: 'builtin-ask_user',
      description: 'Prompt the user for missing statistical analysis inputs.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          question: { type: 'string' as const },
        },
        required: ['question'],
      },
    },
  ],
};

const xlsxToolsSkill = {
  id: 'xlsx-tools',
  name: 'xlsx-tools',
  description: 'Minimal XLSX tool group for SPSS skill tests.',
  content: 'xlsx helper',
  sourcePath: 'tests://xlsx-tools',
  location: 'builtin' as const,
  skillType: 'standalone' as const,
  embeddedTools: [
    {
      name: 'builtin-xlsx_read_structured',
      description: 'Read XLSX content as structured text.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          resource_id: { type: 'string' as const },
        },
        required: ['resource_id'],
      },
    },
    {
      name: 'builtin-xlsx_extract_tables',
      description: 'Extract XLSX worksheets as JSON tables.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          resource_id: { type: 'string' as const },
        },
        required: ['resource_id'],
      },
    },
  ],
};

const canvasNoteSkill = {
  id: 'canvas-note',
  name: 'canvas-note',
  description: 'Minimal note writing tool group for SPSS skill tests.',
  content: 'canvas helper',
  sourcePath: 'tests://canvas-note',
  location: 'builtin' as const,
  skillType: 'standalone' as const,
  embeddedTools: [
    {
      name: 'builtin-note_create',
      description: 'Create a statistical analysis note.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          title: { type: 'string' as const },
        },
      },
    },
    {
      name: 'builtin-note_append',
      description: 'Append to a statistical analysis note.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          note_id: { type: 'string' as const },
          content: { type: 'string' as const },
        },
      },
    },
  ],
};

function readProjectSkill(skillId: string): string {
  return readFileSync(
    path.join(PROJECT_ROOT, '.skills', skillId, 'SKILL.md'),
    'utf8'
  );
}

function parseProjectSkill(skillId: string) {
  const parsed = parseSkillFile(
    readProjectSkill(skillId),
    path.join(PROJECT_ROOT, '.skills', skillId, 'SKILL.md'),
    skillId,
    'project'
  );

  expect(parsed.success).toBe(true);
  expect(parsed.skill).toBeDefined();
  return parsed.skill!;
}

describe('SPSS project skills', () => {
  beforeEach(() => {
    skillRegistry.clear();
    clearSessionSkills(SESSION_ID);
  });

  afterEach(() => {
    skillRegistry.clear();
    clearSessionSkills(SESSION_ID);
  });

  it('defines project-level SPSS paper analysis metadata and workflow guardrails', () => {
    const skill = parseProjectSkill('spss-paper-analysis');
    const validation = validateSkillMetadata(skill);

    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(skill.skillType).toBe('composite');
    expect(skill.dependencies).toEqual(['ask-user']);
    expect(skill.relatedSkills).toEqual([
      'statistics-tools',
      'learning-resource',
      'xlsx-tools',
      'canvas-note',
    ]);
    expect(skill.allowedTools).toEqual(
      expect.arrayContaining([
        'builtin-ask_user',
        'builtin-resource_list',
        'builtin-resource_read',
        'builtin-resource_search',
        'builtin-xlsx_read_structured',
        'builtin-xlsx_extract_tables',
        'builtin-note_create',
        'builtin-note_set',
        'builtin-note_append',
        'builtin-note_replace',
      ])
    );

    expect(skill.content).toContain('load_skills');
    expect(skill.content).toContain('statistics-tools');
    expect(skill.content).toContain('learning-resource');
    expect(skill.content).toContain('xlsx-tools');
    expect(skill.content).toContain('canvas-note');
    expect(skill.content).toContain('禁止根据列名或表头自行猜测变量角色');
    expect(skill.content).toContain('只解读，不假装已经重新跑过统计');
    expect(skill.content).toContain('当前只能解读现有输出，不能实际运行统计');
    expect(skill.content).toContain('当前模型不支持直接查看图片/截图');
    expect(skill.content).toContain('超出当前技能首批支持范围');
  });

  it('defines MCP statistics tool interfaces and supported analysis types', () => {
    const skill = parseProjectSkill('statistics-tools');
    const validation = validateSkillMetadata(skill);

    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(skill.skillType).toBe('standalone');

    const tools = skill.embeddedTools ?? [];
    expect(tools.map((tool) => tool.name)).toEqual([
      'mcp_stats_inspect_dataset',
      'mcp_stats_run_analysis',
      'mcp_stats_explain_result',
      'mcp_stats_export_tables',
    ]);

    const runAnalysisTool = tools.find((tool) => tool.name === 'mcp_stats_run_analysis');
    expect(runAnalysisTool).toBeDefined();
    expect(runAnalysisTool?.inputSchema.properties.analysis_type).toMatchObject({
      type: 'string',
      enum: [
        'descriptive',
        'reliability',
        'correlation',
        'independent_t_test',
        'paired_t_test',
        'one_way_anova',
        'chi_square',
        'linear_regression',
      ],
    });
    expect(runAnalysisTool?.description).toContain('analysis_type');
    expect(runAnalysisTool?.description).toContain('assumption_checks');
    expect(runAnalysisTool?.description).toContain('narrative_summary');
  });

  it('loads the SPSS workflow dependency first and then pulls related tool skills through load_skills', () => {
    const mainSkill = parseProjectSkill('spss-paper-analysis');
    const toolSkill = parseProjectSkill('statistics-tools');

    skillRegistry.registerMany([
      askUserSkill,
      xlsxToolsSkill,
      canvasNoteSkill,
      mainSkill,
      toolSkill,
    ]);

    const initial = JSON.parse(
      handleLoadSkillsToolCall(SESSION_ID, { skills: ['spss-paper-analysis'] })
    );
    expect(initial.result.status).toBe('success');
    expect(initial.result.loaded_skill_ids).toEqual(
      expect.arrayContaining(['ask-user', 'spss-paper-analysis'])
    );
    expect(initial.result.loaded_tool_names).toContain('builtin-ask_user');

    const related = JSON.parse(
      handleLoadSkillsToolCall(SESSION_ID, {
        skills: ['statistics-tools', 'xlsx-tools', 'canvas-note'],
      })
    );
    expect(related.result.status).toBe('success');
    expect(related.result.loaded_skill_ids).toEqual(
      expect.arrayContaining([
        'statistics-tools',
        'xlsx-tools',
        'canvas-note',
      ])
    );

    const loadedToolNames = getLoadedToolSchemas(SESSION_ID).map((tool) => tool.name);
    expect(loadedToolNames).toEqual(
      expect.arrayContaining([
        'mcp_stats_inspect_dataset',
        'mcp_stats_run_analysis',
        'mcp_stats_explain_result',
        'mcp_stats_export_tables',
        'builtin-xlsx_read_structured',
        'builtin-xlsx_extract_tables',
        'builtin-note_create',
        'builtin-note_append',
      ])
    );
  });
});
