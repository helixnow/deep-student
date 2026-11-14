import { describe, expect, it } from 'vitest';
import {
  createTodoList, createTodoStep, todoCompletedCount, todoCurrentRunning, todoIsAllDone,
  todoNextPending, todoToolSchemas, todoTotalCount,
} from '../src/todo.ts';

describe('todo_executor.rs data model and schema', () => {
  it('test_todo_step_creation', () => {
    const step = createTodoStep('step_1', '测试步骤');
    expect(step.id).toBe('step_1');
    expect(step.status).toBe('pending');
    expect(step.result).toBeNull();
  });

  it('test_todo_list_creation', () => {
    const steps = [
      createTodoStep('step_1', '步骤1'),
      createTodoStep('step_2', '步骤2'),
    ];
    const list = createTodoList('测试任务', steps);
    expect(todoTotalCount(list)).toBe(2);
    expect(todoCompletedCount(list)).toBe(0);
    expect(todoIsAllDone(list)).toBe(false);
    expect(todoNextPending(list)?.id).toBe('step_1');
    expect(todoCurrentRunning(list)).toBeNull();
  });

  it('test_todo_list_completion', () => {
    const list = createTodoList('测试', [createTodoStep('step_1', '步骤1')]);
    list.steps[0]!.status = 'completed';
    expect(todoIsAllDone(list)).toBe(true);
    expect(todoCompletedCount(list)).toBe(1);
  });

  it('test_schema_generation', () => {
    const schemas = todoToolSchemas();
    expect(schemas).toHaveLength(4);
    expect(schemas[0]!.function.name).toBe('todo_init');
    expect(schemas.map((schema) => schema.function.name))
      .toEqual(['todo_init', 'todo_update', 'todo_add', 'todo_get']);
  });
});
