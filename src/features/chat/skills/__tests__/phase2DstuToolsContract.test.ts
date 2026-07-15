import { describe, expect, it } from 'vitest';

import { filesAgentManifest } from '@/features/workbench/apps/files/agentManifest';

import {
  builtinToolSkills,
  canvasNoteSkill,
  dstuToolsSkill,
  getBuiltinToolSkillById,
  learningResourceSkill,
} from '../builtin-tools';
import type { SkillDefinition, ToolSchema } from '../types';

const DSTU_TOOL_NAMES = [
  'builtin-dstu_folder_create',
  'builtin-dstu_folder_rename',
  'builtin-dstu_rename',
  'builtin-dstu_move',
  'builtin-dstu_delete',
  'builtin-dstu_restore',
  'builtin-dstu_list_trash',
  'builtin-dstu_set_favorite',
  'builtin-dstu_purge',
  'builtin-dstu_upload_file',
] as const;

function getTool(skill: SkillDefinition, name: string): ToolSchema {
  const matches = skill.embeddedTools?.filter((tool) => tool.name === name) ?? [];
  expect(matches, `${skill.id} must expose ${name} exactly once`).toHaveLength(1);
  return matches[0];
}

describe('phase 2 DSTU organization tool contracts', () => {
  it('registers one discoverable dstu-tools skill with an exact allowlist', () => {
    expect(getBuiltinToolSkillById('dstu-tools')).toBe(dstuToolsSkill);
    expect(builtinToolSkills.filter((skill) => skill.id === 'dstu-tools')).toHaveLength(1);
    expect(dstuToolsSkill.allowedTools).toEqual(DSTU_TOOL_NAMES);
    expect(dstuToolsSkill.embeddedTools?.map((tool) => tool.name)).toEqual(DSTU_TOOL_NAMES);
  });

  it.each([
    ['builtin-dstu_folder_create', ['title'], ['title', 'parent_id', 'icon', 'color']],
    ['builtin-dstu_folder_rename', ['folder_id', 'title'], ['folder_id', 'title']],
    ['builtin-dstu_rename', ['path', 'new_name'], ['path', 'new_name']],
    ['builtin-dstu_move', ['src', 'dst'], ['src', 'dst']],
    ['builtin-dstu_delete', ['path'], ['path']],
    ['builtin-dstu_restore', ['path'], ['path']],
    ['builtin-dstu_set_favorite', ['path', 'favorite'], ['path', 'favorite']],
    ['builtin-dstu_purge', ['path'], ['path']],
  ])('%s publishes the executor-aligned snake_case schema', (name, required, properties) => {
    const tool = getTool(dstuToolsSkill, name);

    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.inputSchema.required).toEqual(required);
    expect(Object.keys(tool.inputSchema.properties)).toEqual(properties);
    for (const field of required) {
      expect(tool.inputSchema.properties[field], `${name}.${field} must exist`).toBeDefined();
    }
  });

  it('keeps trash listing bounded and exposes its pagination result narrative', () => {
    const trash = getTool(dstuToolsSkill, 'builtin-dstu_list_trash');

    expect(trash.inputSchema).toMatchObject({
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 20 },
        offset: { type: 'integer', minimum: 0, default: 0 },
      },
    });
    for (const field of ['success', 'action', 'items', 'count', 'limit', 'offset', 'has_more', 'next_offset']) {
      expect(trash.description).toContain(field);
    }
  });

  it('requires exactly one upload source and publishes only supported overrides', () => {
    const upload = getTool(dstuToolsSkill, 'builtin-dstu_upload_file');

    expect(upload.inputSchema.additionalProperties).toBe(false);
    expect(Object.keys(upload.inputSchema.properties)).toEqual([
      'local_path',
      'root_id',
      'relative_path',
      'folder_id',
      'name',
      'mime_type',
    ]);
    expect(upload.inputSchema.oneOf).toEqual([
      { type: 'object', required: ['local_path'] },
      { type: 'object', required: ['root_id', 'relative_path'] },
    ]);
    expect(upload.description).toContain('严格二选一');
    for (const field of [
      'success',
      'action',
      'node',
      'source_id',
      'resource_id',
      'path',
      'name',
      'mime_type',
      'size',
      'folder_id',
      'is_new',
      'resource_hash',
    ]) {
      expect(upload.description).toContain(field);
    }
  });

  it.each([
    ['builtin-dstu_folder_create', 'Medium'],
    ['builtin-dstu_folder_rename', 'Medium'],
    ['builtin-dstu_rename', 'Medium'],
    ['builtin-dstu_move', 'Medium'],
    ['builtin-dstu_delete', 'Medium'],
    ['builtin-dstu_restore', 'Medium'],
    ['builtin-dstu_list_trash', 'Low'],
    ['builtin-dstu_set_favorite', 'Low'],
    ['builtin-dstu_purge', 'High'],
    ['builtin-dstu_upload_file', 'Medium'],
  ])('states the authoritative %s risk as %s', (name, risk) => {
    expect(getTool(dstuToolsSkill, name).description).toContain(risk);
  });

  it('describes a usable result for every write instead of claiming only dispatch', () => {
    for (const name of DSTU_TOOL_NAMES) {
      const description = getTool(dstuToolsSkill, name).description;
      expect(description, `${name} must narrate its result`).toContain('返回');
      expect(description).toContain('success');
      expect(description).toContain('action');
    }
  });

  it('forces confirmation for destructive scopes', () => {
    const deletion = getTool(dstuToolsSkill, 'builtin-dstu_delete');
    const purge = getTool(dstuToolsSkill, 'builtin-dstu_purge');

    expect(deletion.description).toMatch(/超过 5 项.*builtin-ask_user/);
    expect(dstuToolsSkill.content).toMatch(/超过 5 项[\s\S]*builtin-ask_user/);
    expect(purge.description).toContain('High');
    expect(purge.description).toContain('不可恢复');
    expect(purge.description).toContain('每次调用前必须');
    expect(purge.description).toContain('builtin-ask_user');
    expect(dstuToolsSkill.content).toMatch(/每次调用前都必须[\s\S]*builtin-ask_user/);
  });

  it('joins learning-resource reads to DSTU writes in both skill narratives', () => {
    for (const readTool of [
      'builtin-folder_list',
      'builtin-resource_list',
      'builtin-resource_search',
    ]) {
      expect(dstuToolsSkill.content).toContain(readTool);
    }
    expect(dstuToolsSkill.content).toContain('learning-resource');
    expect(learningResourceSkill.description).toContain('dstu-tools');
    expect(learningResourceSkill.content).toContain('dstu-tools');
  });
});

describe('phase 2 note lifecycle contracts', () => {
  it('updates tags only from a note_read OCC baseline', () => {
    const updateTags = getTool(canvasNoteSkill, 'builtin-note_update_tags');

    expect(canvasNoteSkill.allowedTools).toContain(updateTags.name);
    expect(updateTags.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ['note_id', 'tags', 'expected_updated_at'],
      properties: {
        note_id: { type: 'string', minLength: 1 },
        tags: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: 100 },
          maxItems: 50,
        },
        expected_updated_at: { type: 'string', minLength: 1 },
      },
    });
    expect(updateTags.description).toContain('note_read');
    expect(updateTags.description).toContain('updatedAt');
    expect(updateTags.description).toContain('OCC');
    for (const field of ['success', 'noteId', 'tags', 'previousTags', 'updatedAt', 'reversible']) {
      expect(updateTags.description).toContain(field);
    }
  });

  it('deletes notes softly and points recovery to the DSTU lifecycle', () => {
    const deletion = getTool(canvasNoteSkill, 'builtin-note_delete');

    expect(canvasNoteSkill.allowedTools).toContain(deletion.name);
    expect(deletion.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ['note_id', 'expected_updated_at'],
      properties: {
        note_id: { type: 'string', minLength: 1 },
        expected_updated_at: { type: 'string', minLength: 1 },
      },
    });
    expect(deletion.description).toContain('Medium');
    expect(deletion.description).toContain('OCC');
    expect(deletion.description).toContain('note_read');
    expect(deletion.description).toContain('updatedAt');
    expect(deletion.description).toContain('软删除');
    expect(deletion.description).toContain('可恢复');
    for (const field of ['success', 'noteId', 'path', 'softDeleted', 'reversible', 'restoreWith']) {
      expect(deletion.description).toContain(field);
    }
    expect(canvasNoteSkill.content).toContain('dstu_list_trash');
    expect(canvasNoteSkill.content).toContain('dstu_restore');
  });

  it('keeps allowed and embedded note tool declarations in sync', () => {
    expect(canvasNoteSkill.allowedTools).toEqual(
      canvasNoteSkill.embeddedTools?.map((tool) => tool.name),
    );
  });
});

describe('phase 2 Files app boundary', () => {
  it('routes domain writes through learning-resource plus dstu-tools', () => {
    expect(filesAgentManifest.description).toContain('learning-resource');
    expect(filesAgentManifest.description).toContain('dstu-tools');
    expect(filesAgentManifest.description).toContain('不走 UI 自动化');
  });
});
