/**
 * `runtime_root_request` 工具执行器测试：逐条对应
 * `chat_v2/tools/runtime_root_request_executor.rs` 的 `mod tests`。
 */
import { expect, it } from 'vitest';
import {
  BROAD_WARNING, CRITICAL_REJECTION, HINT, RuntimeRootRequestExecutor, buildSuccessPayload, parseArgs,
} from '../src/tools/runtime-root-request.ts';
import { assessAuthorizedRootRisk } from '../src/runtime-paths.ts';

it('handles_expected_tool_names', () => {
  const executor = new RuntimeRootRequestExecutor();
  expect(executor.canHandle('runtime_root_request')).toBe(true);
  expect(executor.canHandle('builtin-runtime_root_request')).toBe(true);
  expect(executor.canHandle('runtime_root_request_extra')).toBe(false);
});

it('sensitivity_is_high', () => {
  const executor = new RuntimeRootRequestExecutor();
  expect(executor.sensitivityLevel('builtin-runtime_root_request')).toBe('high');
});

it('critical_paths_are_rejected_by_agent_policy', () => {
  const risk = assessAuthorizedRootRisk('C:\\Users\\foo');
  expect(risk).toBe('critical');
  expect(CRITICAL_REJECTION).toContain('agent 不代理授权');
});

it('parse_args_requires_path_and_purpose', () => {
  expect(() => parseArgs({})).toThrow();
  expect(() => parseArgs({ path: 'C:\\tmp' })).toThrow();
  expect(() => parseArgs({ purpose: 'test' })).toThrow();
});

it('broad_payload_includes_warning', () => {
  const payload = buildSuccessPayload(
    'authorized_abc',
    'C:\\Users\\foo\\Downloads',
    'broad',
    'list exam files',
    true,
  );
  expect(payload['risk']).toBe('broad');
  expect(payload['risk_warning']).toBe(BROAD_WARNING);
  expect(payload['hint']).toBe(HINT);
});
