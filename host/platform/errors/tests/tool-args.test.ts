import { expect, it } from 'vitest';
import { coerce_json_array, get_string_array_arg, with_localized_message, ensure_localized_error, is_external_mcp_tool_name, strip_tool_namespace } from '../api.ts';

it('test_external_mcp_namespace_detection_preserves_source', () => {
  expect(is_external_mcp_tool_name('mcp_workspace_file_read')).toBe(true);
  expect(is_external_mcp_tool_name('mcp.tools.workspace_file_read')).toBe(true);
  expect(is_external_mcp_tool_name('builtin-workspace_file_read')).toBe(false);
  expect(is_external_mcp_tool_name('workspace_file_read')).toBe(false);
});
it('strip_tool_namespace_removes_builtin_and_mcp_prefixes', () => {
  expect(strip_tool_namespace('builtin-note_read')).toBe('note_read');
  expect(strip_tool_namespace('mcp_note_read')).toBe('note_read');
  expect(strip_tool_namespace('note_read')).toBe('note_read');
});
it('test_coerce_json_array_accepts_native_array', () => { expect(coerce_json_array(['a', 'b'])).toEqual(['a', 'b']); });
it('test_coerce_json_array_accepts_stringified_array', () => { expect(coerce_json_array('[{"type":"add_node"}]')).toEqual([{ type: 'add_node' }]); });
it('test_coerce_json_array_rejects_non_array_json_string', () => { expect(coerce_json_array('{"type":"add_node"}')).toBe(null); });
it('test_get_string_array_arg_accepts_stringified_array', () => { expect(get_string_array_arg({ session_ids: '["sess_1", "sess_2"]' }, 'session_ids')).toEqual(['sess_1', 'sess_2']); });
it('test_with_localized_message_keeps_machine_and_readable_fallbacks', () => {
  const p = with_localized_message({ success: true }, 'chat.tools.todo.created', { title: 'Read chapter 1' }, '已创建待办项「Read chapter 1」', 'Created todo item "Read chapter 1".');
  expect(p.messageKey).toBe('chat.tools.todo.created');
  expect(p.messageParams).toEqual({ title: 'Read chapter 1' });
  expect(p.messageFallback).toEqual({ 'zh-CN': '已创建待办项「Read chapter 1」', 'en-US': 'Created todo item "Read chapter 1".' });
  expect(p.message).toContain(' / Created todo item');
});
it('test_ensure_localized_error_wraps_plain_and_legacy_errors', () => {
  const plain = JSON.parse(ensure_localized_error('缺少必需参数: title', 'TODO_OPERATION_FAILED', 'chat.tools.todo.error', '待办操作失败', 'The todo operation failed.'));
  expect(plain.code).toBe('TODO_OPERATION_FAILED'); expect(plain.detail).toBe('缺少必需参数: title');
  expect(plain.messageKey).toBe('chat.tools.todo.error'); expect(typeof plain.messageFallback['en-US']).toBe('string');
  const legacy = JSON.parse(ensure_localized_error(JSON.stringify({ code: 'QBANK_CONFLICT', current: { id: 'q_1' } }), 'QBANK_OPERATION_FAILED', 'chat.tools.qbank.error', '题库操作失败', 'The question-bank operation failed.'));
  expect(legacy.code).toBe('QBANK_CONFLICT'); expect(legacy.current.id).toBe('q_1');
  expect(legacy.messageKey).toBe('chat.tools.qbank.error'); expect(legacy.messageParams.code).toBe('QBANK_CONFLICT'); expect(legacy).not.toHaveProperty('detail');
});
it('test_ensure_localized_error_preserves_complete_contract', () => {
  const original = with_localized_message({ code: 'TODO_CONFLICT', retryable: false }, 'chat.tools.todo.conflict', { action: 'update', code: 'TODO_CONFLICT' }, '待办已变化', 'The todo changed.');
  expect(JSON.parse(ensure_localized_error(JSON.stringify(original), 'TODO_OPERATION_FAILED', 'chat.tools.todo.error', '待办操作失败', 'The todo operation failed.'))).toEqual(original);
});
it('test_ensure_localized_error_bounds_internal_detail', () => {
  const p = JSON.parse(ensure_localized_error('x'.repeat(2001), 'RETRIEVAL_OPERATION_FAILED', 'chat.tools.retrieval.error', '检索失败', 'Retrieval failed.'));
  expect([...p.detail]).toHaveLength(2000); expect(p.detailTruncated).toBe(true);
});
