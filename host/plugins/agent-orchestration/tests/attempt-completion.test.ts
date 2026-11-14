import { describe, expect, it } from 'vitest';
import {
  attemptCompletionSchema, executeAttemptCompletion, isAttemptCompletion,
  parseAttemptCompletionParams,
} from '../src/attempt-completion.ts';

describe('attempt_completion.rs parsing and schema', () => {
  it('test_parse_params', () => {
    const params = parseAttemptCompletionParams({ result: '任务完成', command: 'cargo build' });
    expect(params.result).toBe('任务完成');
    expect(params.command).toBe('cargo build');
  });

  it('test_parse_params_without_command', () => {
    const params = parseAttemptCompletionParams({ result: '任务完成' });
    expect(params.result).toBe('任务完成');
    expect(params.command).toBeNull();
    expect(params.artifacts).toBeNull();
  });

  it('test_parse_params_with_artifacts', () => {
    const params = parseAttemptCompletionParams({
      result: '已生成报告',
      artifacts: [
        { path: 'report.md', sha256: 'abc123' },
        { path: 'data/out.xlsx', root_id: 'workspace' },
      ],
    });
    const artifacts = params.artifacts!;
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]!.path).toBe('report.md');
    expect(artifacts[0]!.sha256).toBe('abc123');
    expect(artifacts[0]!.rootId).toBeNull();
    expect(artifacts[1]!.path).toBe('data/out.xlsx');
    expect(artifacts[1]!.rootId).toBe('workspace');
    expect(artifacts[1]!.sha256).toBeNull();
  });

  it('test_parse_params_rejects_malformed_artifacts', () => {
    expect(() => parseAttemptCompletionParams({ result: '任务完成', artifacts: [{ sha256: 'abc123' }] }))
      .toThrow();
    expect(() => parseAttemptCompletionParams({ result: '任务完成', artifacts: 'not-an-array' }))
      .toThrow();
  });

  it('test_execute', () => {
    const result = executeAttemptCompletion({ result: '测试完成', command: null, artifacts: null });
    expect(result.completed).toBe(true);
    expect(result.result).toBe('测试完成');
  });

  it('test_schema', () => {
    const schema = attemptCompletionSchema() as {
      function: { name: string; parameters: { properties: Record<string, unknown>; required: string[] } };
    };
    expect(schema.function.name).toBe('attempt_completion');
    expect(typeof schema.function.parameters.properties.artifacts).toBe('object');
    expect(schema.function.parameters.required).toEqual(['result']);
  });

  it('mcp_namespaced_names_are_not_attempt_completion', () => {
    expect(isAttemptCompletion('attempt_completion')).toBe(true);
    expect(isAttemptCompletion('builtin-attempt_completion')).toBe(true);
    expect(isAttemptCompletion('builtin:attempt_completion')).toBe(true);
    expect(isAttemptCompletion('mcp_attempt_completion')).toBe(false);
    expect(isAttemptCompletion('mcp.tools.attempt_completion')).toBe(false);
    expect(isAttemptCompletion('other_tool')).toBe(false);
  });
});
