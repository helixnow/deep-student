import { describe, expect, it } from 'vitest';

import { automationToolsSkill } from '../builtin-tools/automation-tools';
import { userTodoToolsSkill } from '../builtin-tools/user-todo-tools';
import type { SkillDefinition, ToolSchema } from '../types';

function getTool(skill: SkillDefinition, name: string): ToolSchema {
  const matches = skill.embeddedTools?.filter((tool) => tool.name === name) ?? [];
  expect(matches, `${skill.id} must expose ${name} exactly once`).toHaveLength(1);
  return matches[0];
}

function expectAllowedToolsMatchEmbedded(skill: SkillDefinition) {
  const allowed = [...new Set(skill.allowedTools ?? [])].sort();
  const embedded = (skill.embeddedTools ?? []).map((tool) => tool.name).sort();
  expect(allowed).toEqual(embedded);
}

describe('phase 5 user todo tool surface', () => {
  it('exposes list, item, search, trash, restore, and reorder operations', () => {
    for (const name of [
      'builtin-user_todo_delete_item',
      'builtin-user_todo_create_list',
      'builtin-user_todo_update_list',
      'builtin-user_todo_delete_list',
      'builtin-user_todo_search',
      'builtin-user_todo_list_trash',
      'builtin-user_todo_restore',
      'builtin-user_todo_reorder',
    ]) {
      expect(getTool(userTodoToolsSkill, name)).toBeDefined();
    }
    expectAllowedToolsMatchEmbedded(userTodoToolsSkill);
  });

  it('requires explicit ask_user confirmation for High list deletion', () => {
    const deletion = getTool(userTodoToolsSkill, 'builtin-user_todo_delete_list');
    expect(deletion.description).toContain('High');
    expect(deletion.description).toContain('builtin-ask_user');
    expect(deletion.description).toContain('不得记住');
    expect(deletion.inputSchema).toMatchObject({
      required: ['list_id', 'expected_updated_at'],
      additionalProperties: false,
      properties: {
        list_id: { type: 'string', minLength: 1 },
        expected_updated_at: { type: 'string', minLength: 1 },
      },
    });
  });

  it.each([
    'builtin-user_todo_delete_item',
    'builtin-user_todo_update_list',
    'builtin-user_todo_delete_list',
    'builtin-user_todo_reorder',
  ])('%s requires an OCC baseline', (name) => {
    const tool = getTool(userTodoToolsSkill, name);
    expect(tool.inputSchema.required).toContain('expected_updated_at');
    expect(tool.inputSchema.properties.expected_updated_at).toMatchObject({
      type: 'string',
      minLength: 1,
    });
  });

  it('documents the structured current snapshot returned on todo conflicts', () => {
    const update = getTool(userTodoToolsSkill, 'builtin-user_todo_update_item');
    expect(update.description).toContain('TODO_CONFLICT');
    expect(update.description).toContain('currentUpdatedAt');
  });

  it('requires update_list to change at least one editable field', () => {
    const update = getTool(userTodoToolsSkill, 'builtin-user_todo_update_list');
    expect(update.inputSchema.anyOf).toEqual([
      { required: ['title'] },
      { required: ['description'] },
      { required: ['icon'] },
      { required: ['color'] },
    ]);
  });

  it('makes trash observable before restore', () => {
    const trash = getTool(userTodoToolsSkill, 'builtin-user_todo_list_trash');
    const restore = getTool(userTodoToolsSkill, 'builtin-user_todo_restore');

    expect(trash.inputSchema).toMatchObject({
      required: ['entity_type'],
      additionalProperties: false,
      properties: {
        entity_type: { enum: ['item', 'list'] },
        page_size: { maximum: 20 },
      },
    });
    expect(restore.inputSchema).toMatchObject({
      required: ['entity_type', 'entity_id'],
      additionalProperties: false,
      properties: {
        entity_type: { enum: ['item', 'list'] },
        entity_id: { type: 'string', minLength: 1 },
      },
    });
  });

  it.each([
    'builtin-user_todo_list_lists',
    'builtin-user_todo_list_items',
    'builtin-user_todo_search',
    'builtin-user_todo_list_trash',
  ])('%s limits every page to 20 records', (name) => {
    const tool = getTool(userTodoToolsSkill, name);
    expect(tool.inputSchema.properties.page).toMatchObject({ type: 'integer', minimum: 1 });
    expect(tool.inputSchema.properties.page_size).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 20,
    });
  });

  it('uses the backend pagination field names in workflow guidance', () => {
    expect(userTodoToolsSkill.content).toContain('has_more');
    expect(userTodoToolsSkill.content).not.toContain('hasMore');
  });

  it('uses the active LLM plus repeated create_item calls for breakdown', () => {
    expect(userTodoToolsSkill.content).toContain('由当前 LLM 自己拆');
    expect(userTodoToolsSkill.content).toContain('循环调用 create_item');
    expect(userTodoToolsSkill.allowedTools).not.toContain('builtin-user_todo_ai_breakdown');
  });

  it.each([
    ['builtin-user_todo_create_item', 'Medium'],
    ['builtin-user_todo_complete_item', 'Medium'],
    ['builtin-user_todo_update_item', 'Medium'],
    ['builtin-user_todo_create_list', 'Medium'],
    ['builtin-user_todo_update_list', 'Medium'],
    ['builtin-user_todo_delete_item', 'Medium'],
    ['builtin-user_todo_delete_list', 'High'],
    ['builtin-user_todo_search', 'Low'],
    ['builtin-user_todo_list_trash', 'Low'],
    ['builtin-user_todo_restore', 'Medium'],
    ['builtin-user_todo_reorder', 'Medium'],
  ])('%s declares %s sensitivity', (name, sensitivity) => {
    expect(getTool(userTodoToolsSkill, name).description).toContain(sensitivity);
  });

  it('keeps new todo mutations out of unattended automation guidance', () => {
    expect(userTodoToolsSkill.content).toMatch(/清单写入、删除、恢复与重排[\s\S]*不向 headless/);
  });
});

describe('phase 5 automation tool surface', () => {
  it('exposes complete definition and run management schemas', () => {
    const setEnabled = getTool(automationToolsSkill, 'builtin-automation_set_enabled');
    const update = getTool(automationToolsSkill, 'builtin-automation_update');
    const deletion = getTool(automationToolsSkill, 'builtin-automation_delete');
    const runNow = getTool(automationToolsSkill, 'builtin-automation_run_now');
    const runs = getTool(automationToolsSkill, 'builtin-automation_runs');
    const retryRun = getTool(automationToolsSkill, 'builtin-automation_retry_run');
    const cancelRun = getTool(automationToolsSkill, 'builtin-automation_cancel_run');

    expect(update.inputSchema).toMatchObject({
      required: ['id', 'expected_version'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', minLength: 1 },
        expected_version: { type: 'integer', minimum: 1 },
        schedule: { type: 'object' },
        prompt: { type: 'string', maxLength: 4000 },
        action_type: { enum: ['notify', 'agent_turn'] },
        catch_up_policy: { enum: ['skip', 'run_once', 'catch_up_all'] },
        max_retries: { maximum: 10 },
        timeout_seconds: { maximum: 3600 },
      },
    });
    expect(update.inputSchema.properties.schedule.properties?.kind.enum).toEqual([
      'daily', 'weekdays', 'weekly', 'monthly', 'interval',
    ]);
    for (const tool of [setEnabled, deletion, runNow]) {
      expect(tool.inputSchema).toMatchObject({
        required: expect.arrayContaining(['id', 'expected_version']),
        properties: {
          expected_version: { type: 'integer', minimum: 1 },
        },
      });
      expect(tool.description).toContain('expected_version');
    }
    expect(update.description).toContain('Medium');
    expect(update.description).toContain('expected_version');
    expect(automationToolsSkill.content).toContain('版本冲突时必须重新 list');
    expect(automationToolsSkill.content).toContain('AUTOMATION_OCC_REQUIRED');
    expect(automationToolsSkill.content).toContain('AUTOMATION_VERSION_CONFLICT');
    expect(runNow.description).toContain('Medium');
    expect(runs.description).toContain('Low');
    expect(retryRun.description).toContain('Medium');
    expect(cancelRun.description).toContain('Medium');
    expect(deletion.description).toContain('High');
    expect(deletion.description).toContain('builtin-ask_user');
    expect(deletion.description).toContain('不可恢复');
    expectAllowedToolsMatchEmbedded(automationToolsSkill);
  });

  it('documents full editing, timezone, and catch-up behavior', () => {
    expect(automationToolsSkill.content).toContain('修改名称、调度、动作');
    expect(automationToolsSkill.content).toContain('action_type');
    expect(automationToolsSkill.content).toContain('IANA');
    expect(automationToolsSkill.content).toContain('catch_up_all');
    expect(automationToolsSkill.content).not.toContain('update 只修改 schedule/prompt');
  });
});
