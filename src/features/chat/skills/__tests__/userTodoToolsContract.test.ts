import { describe, expect, it } from 'vitest';
import { userTodoToolsSkill } from '../builtin-tools/user-todo-tools';

describe('user todo ACR 3.0 OCC contract', () => {
  it.each([
    'builtin-user_todo_complete_item',
    'builtin-user_todo_update_item',
  ])('%s requires the read baseline', (name) => {
    const tool = userTodoToolsSkill.embeddedTools?.find((candidate) => candidate.name === name);
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.required).toContain('expected_updated_at');
    expect(tool!.inputSchema.additionalProperties).toBe(false);
    expect(tool!.inputSchema.properties.expected_updated_at).toMatchObject({
      type: 'string',
      minLength: 1,
    });
  });

  it('documents list_items.updatedAt as the next write baseline', () => {
    const list = userTodoToolsSkill.embeddedTools?.find(
      (candidate) => candidate.name === 'builtin-user_todo_list_items',
    );
    expect(list?.description).toContain('updatedAt');
  });
});
