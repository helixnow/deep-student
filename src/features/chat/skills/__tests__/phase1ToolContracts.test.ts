import { describe, expect, it } from 'vitest';

import {
  attachmentToolsSkill,
  canvasNoteSkill,
  qbankToolsSkill,
  reviewPlanningSkill,
  sessionManagerSkill,
  userTodoToolsSkill,
  workbenchToolsSkill,
} from '../builtin-tools';
import type { SkillDefinition, ToolSchema } from '../types';

function getTool(skill: SkillDefinition, name: string): ToolSchema {
  const matches = skill.embeddedTools?.filter((candidate) => candidate.name === name) ?? [];
  expect(matches, `${skill.id} must expose ${name} exactly once`).toHaveLength(1);
  return matches[0];
}

describe('phase 1 declared tool contracts', () => {
  it('requires a submission before qbank AI grading and describes real grading', () => {
    const grade = getTool(qbankToolsSkill, 'builtin-qbank_ai_grade');

    expect(qbankToolsSkill.allowedTools).toContain(grade.name);
    expect(grade.inputSchema.required).toContain('submission_id');
    expect(grade.inputSchema.properties.submission_id).toMatchObject({
      type: 'string',
      minLength: 1,
    });
    expect(grade.description).toContain('真实 AI');
    expect(grade.description).toContain('持久化');
    expect(grade.description).not.toContain('请在题目集练习界面中使用此功能');
  });

  it('exposes folder and tag placement when creating a note', () => {
    const create = getTool(canvasNoteSkill, 'builtin-note_create');

    expect(canvasNoteSkill.allowedTools).toContain(create.name);
    expect(create.inputSchema.properties.folder_id).toMatchObject({ type: 'string' });
    expect(create.inputSchema.properties.tags).toMatchObject({
      type: 'array',
      items: { type: 'string' },
    });
  });

  it('exposes reminder, repeat, and parent fields for user todo creation and update', () => {
    const create = getTool(userTodoToolsSkill, 'builtin-user_todo_create_item');
    const update = getTool(userTodoToolsSkill, 'builtin-user_todo_update_item');

    for (const schema of [create.inputSchema, update.inputSchema]) {
      expect(schema.properties.reminder).toMatchObject({ type: 'string' });
      expect(schema.properties.parent_id).toMatchObject({ type: 'string' });
      expect(schema.properties.repeat).toMatchObject({
        type: 'object',
        required: ['freq'],
        properties: {
          freq: { type: 'string' },
        },
      });
    }

    for (const clearFlag of ['clear_reminder', 'clear_parent', 'clear_repeat']) {
      expect(update.inputSchema.properties[clearFlag]).toMatchObject({ type: 'boolean' });
    }

    const embeddedNames = userTodoToolsSkill.embeddedTools?.map((tool) => tool.name).sort();
    expect([...new Set(userTodoToolsSkill.allowedTools)].sort()).toEqual(embeddedNames);
  });

  it('advertises only image and document attachment kinds', () => {
    const list = getTool(attachmentToolsSkill, 'builtin-attachment_list');

    expect(list.inputSchema.properties.type.enum).toEqual(['image', 'document', 'all']);
    expect(attachmentToolsSkill.content).toContain('不提供音频转写或视频解析');
  });

  it('states that session_get returns metadata rather than message bodies', () => {
    const get = getTool(sessionManagerSkill, 'builtin-session_get');

    expect(get.description).toContain('元数据');
    expect(get.description).toContain('不返回消息正文');
    expect(sessionManagerSkill.content).toMatch(/session_get[^\n]*元数据[^\n]*不返回消息全文/);
  });

  it.each([
    ['builtin-review_suspend', 'Medium'],
    ['builtin-review_resume', 'Medium'],
    ['builtin-review_delete', 'High'],
  ])('exposes %s as a %s plan operation', (name, risk) => {
    const operation = getTool(reviewPlanningSkill, name);

    expect(reviewPlanningSkill.allowedTools).toContain(name);
    expect(operation.description).toContain(risk);
    expect(operation.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ['plan_id', 'expected_updated_at'],
      properties: {
        plan_id: { type: 'string', minLength: 1 },
        expected_updated_at: { type: 'string', minLength: 1 },
      },
    });
  });

  it('requires explicit confirmation for irreversible review deletion', () => {
    const deletion = getTool(reviewPlanningSkill, 'builtin-review_delete');

    expect(deletion.description).toContain('builtin-ask_user');
    expect(deletion.description).toContain('不可恢复');
    expect(reviewPlanningSkill.content).not.toContain('说明可在复习界面暂停');
  });

  it('gives truthful browser guidance for Linux workbench users', () => {
    expect(workbenchToolsSkill.content).toMatch(
      /browser 领域工具[^\n]*在 Windows\/macOS 暴露/,
    );
    expect(workbenchToolsSkill.content).toContain('Linux');
    expect(workbenchToolsSkill.content).toMatch(/Linux[^\n]*workbench[^\n]*请用户接管/);
  });
});
