import { describe, expect, it } from 'vitest';
import {
  canHandleGoalTool, goalToolSchemas, parseGoalTokenBudget,
} from '../src/goal-tools.ts';
import {
  canHandleSubagentTool, managesSubagentCancellation, SUBAGENT_CALL_SENSITIVITY,
} from '../src/subagent-args.ts';

describe('goal_executor.rs tool schemas and budget', () => {
  it('test_can_handle_with_and_without_prefix', () => {
    for (const name of ['goal_create', 'goal_update', 'goal_get',
      'builtin-goal_create', 'builtin-goal_update', 'builtin-goal_get']) {
      expect(canHandleGoalTool(name)).toBe(true);
    }
    expect(canHandleGoalTool('todo_init')).toBe(false);
    expect(canHandleGoalTool('goal_delete')).toBe(false);
  });

  it('test_schema_generation', () => {
    const schemas = goalToolSchemas();
    expect(schemas).toHaveLength(3);
    expect(schemas[0]!.function.name).toBe('goal_create');
    expect(schemas[1]!.function.name).toBe('goal_update');
    expect(schemas[2]!.function.name).toBe('goal_get');
    const status = schemas[1]!.function.parameters.properties.status as { enum: string[] };
    expect(status.enum).toEqual(['complete', 'blocked', 'waiting_user']);
  });

  it('test_parse_token_budget', () => {
    expect(parseGoalTokenBudget({})).toBeNull();
    expect(parseGoalTokenBudget({ token_budget: 1000 })).toBe(1000);
    expect(() => parseGoalTokenBudget({ token_budget: 0 })).toThrow();
    expect(() => parseGoalTokenBudget({ token_budget: -5 })).toThrow();
    expect(() => parseGoalTokenBudget({ token_budget: '1000' })).toThrow();
  });
});

describe('subagent_executor.rs tool metadata', () => {
  it('subagent_call_is_a_medium_sensitivity_mutation', () => {
    expect(canHandleSubagentTool('subagent_call')).toBe(true);
    expect(canHandleSubagentTool('builtin-subagent_call')).toBe(true);
    expect(SUBAGENT_CALL_SENSITIVITY).toBe('Medium');
    expect(managesSubagentCancellation('subagent_call')).toBe(true);
  });
});
