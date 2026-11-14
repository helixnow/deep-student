import { expect, it } from 'vitest';
import type { ToolResultInfo } from '../api.ts';

it('ToolResultInfo uses the Rust serde camelCase shape and omits absent options', () => {
  const result: ToolResultInfo = {
    toolCallId: 'call-1', blockId: 'block-1', toolName: 'template_list',
    input: {}, output: { count: 0, templates: [] }, success: true, durationMs: 0,
  };
  expect(JSON.parse(JSON.stringify(result))).toEqual({
    toolCallId: 'call-1', blockId: 'block-1', toolName: 'template_list',
    input: {}, output: { count: 0, templates: [] }, success: true, durationMs: 0,
  });
  expect(result).not.toHaveProperty('error');
  expect(result).not.toHaveProperty('reasoningContent');
});
