import { describe, expect, it } from 'vitest';
import {
  batchMoveConfirmationRequired, batchOpsConfirmationRequired, batchTagConfirmationRequired,
  canHandleSessionTool, isSessionTool, markdownExportToToolValue, MAX_TOOL_FIELD_CHARS,
  messageToToolValue, parseBoundedU32, parseExportRange, parseRoleFilter,
  parseSearchDateRange, renderSessionMarkdown, selectExportMessages, sessionSensitivityLevel,
  hasDynamicSessionSensitivity, type SessionBlock, type SessionMessage,
} from '../src/session-tools.ts';

function message(
  id: string, role: 'user' | 'assistant', timestamp: number, blockIds: string[],
): SessionMessage {
  return { id, role, timestamp, blockIds };
}

function block(overrides: Partial<SessionBlock> & Pick<SessionBlock, 'id' | 'messageId'>): SessionBlock {
  return {
    blockIndex: 0,
    blockType: 'content',
    status: 'success',
    ...overrides,
  };
}

describe('session_executor.rs validation and export', () => {
  it('test_is_session_tool', () => {
    for (const name of ['session_list', 'session_search', 'session_get_messages', 'session_export',
      'group_create', 'session_batch_move', 'session_batch_ops']) {
      expect(isSessionTool(name), name).toBe(true);
    }
    expect(isSessionTool('note_read')).toBe(false);
    expect(isSessionTool('todo_init')).toBe(false);
  });

  it('test_can_handle_with_prefix', () => {
    expect(canHandleSessionTool('builtin-session_list')).toBe(true);
    expect(canHandleSessionTool('session_list')).toBe(true);
    expect(canHandleSessionTool('mcp_session_search')).toBe(true);
    expect(canHandleSessionTool('builtin-session_get_messages')).toBe(true);
    expect(canHandleSessionTool('builtin-session_export')).toBe(true);
    expect(canHandleSessionTool('builtin-note_read')).toBe(false);
  });

  it('test_sensitivity_levels', () => {
    expect(sessionSensitivityLevel('session_list')).toBe('Low');
    expect(sessionSensitivityLevel('session_tag_add')).toBe('Medium');
    expect(sessionSensitivityLevel('session_export')).toBe('Medium');
    expect(sessionSensitivityLevel('session_archive')).toBe('High');
    expect(sessionSensitivityLevel('builtin-session_batch_ops')).toBe('Medium');
    expect(hasDynamicSessionSensitivity('builtin-session_batch_ops')).toBe(true);
    expect(hasDynamicSessionSensitivity('builtin-session_archive')).toBe(false);
    expect(sessionSensitivityLevel('session_batch_move')).toBe('Medium');
  });

  it('test_batch_ops_confirmation_required', () => {
    expect(batchOpsConfirmationRequired(3, false)).toBe(false);
    expect(batchOpsConfirmationRequired(4, false)).toBe(true);
    expect(batchOpsConfirmationRequired(1, true)).toBe(true);
  });

  it('test_batch_move_tag_confirmation_required', () => {
    expect(batchMoveConfirmationRequired(3)).toBe(false);
    expect(batchMoveConfirmationRequired(4)).toBe(true);
    expect(batchTagConfirmationRequired(5)).toBe(false);
    expect(batchTagConfirmationRequired(6)).toBe(true);
  });

  it('test_message_page_argument_validation', () => {
    expect(parseBoundedU32({}, 'page_size', 20, 1, 20)).toBe(20);
    expect(() => parseBoundedU32({ page_size: 21 }, 'page_size', 20, 1, 20))
      .toThrow(/between 1 and 20/);
    expect(parseRoleFilter({ role_filter: 'assistant' })).toBe('assistant');
    expect(() => parseRoleFilter({ role_filter: 'tool' }))
      .toThrow(/SESSION_INVALID_ROLE_FILTER/);
  });

  it('test_date_only_range_is_inclusive_for_entire_end_day', () => {
    const range = parseSearchDateRange({ date_from: '2026-07-01', date_to: '2026-07-13' });
    expect(range.dateFrom).toBe('2026-07-01T00:00:00.000Z');
    expect(range.dateTo).toBe('2026-07-13T23:59:59.999Z');
    expect(() => parseSearchDateRange({ date_from: '2026-07-14', date_to: '2026-07-13' }))
      .toThrow(/SESSION_INVALID_DATE_RANGE/);
  });

  it('test_message_output_truncates_fields_and_summarizes_tools', () => {
    const target = message('msg_output', 'assistant', 1_700_000_000_000,
      ['blk_content', 'blk_tool', 'blk_string_tool']);
    const content = block({
      id: 'blk_content', messageId: target.id, blockType: 'content',
      content: '界'.repeat(MAX_TOOL_FIELD_CHARS + 1),
    });
    const tool = block({
      id: 'blk_tool', messageId: target.id, blockIndex: 1, blockType: 'tool', status: 'success',
      toolName: 'builtin-example', toolOutput: { payload: 'private raw payload', items: [1, 2, 3] },
    });
    const stringTool = block({
      id: 'blk_string_tool', messageId: target.id, blockIndex: 2, blockType: 'tool', status: 'success',
      toolName: 'builtin-string-output', toolOutput: 'S'.repeat(500),
    });
    const output = messageToToolValue(target, [content, tool, stringTool]);
    expect([...String(output.content)].length).toBe(MAX_TOOL_FIELD_CHARS);
    expect(output.truncated).toBe(true);
    const blocks = output.blocks as Array<Record<string, unknown>>;
    expect(blocks[1]!.isToolOutput).toBe(true);
    expect(blocks[1]!.summary).toBe('Tool returned fields: items, payload');
    expect(blocks[1]!.toolOutput).toBeUndefined();
    expect(JSON.stringify(output)).not.toContain('private raw payload');
    expect(JSON.stringify(output)).not.toContain('must-not-be-returned');
    expect(blocks[2]!.toolOutputTruncated).toBe(true);
    expect(blocks[2]!.truncated).toBe(true);
    expect(String(blocks[2]!.summary).startsWith('Tool returned text (500 characters): ')).toBe(true);
    expect(JSON.stringify(output)).not.toContain('S'.repeat(201));
  });

  it('test_export_range_is_inclusive_and_markdown_omits_thinking', () => {
    const messages: SessionMessage[] = [];
    const blocks: SessionBlock[] = [];
    for (let index = 0; index < 3; index += 1) {
      const id = `msg_export_${index}`;
      const entry = message(id, index % 2 === 0 ? 'user' : 'assistant', 1_700_000_000_000 + index,
        [`blk_export_content_${index}`, `blk_export_thinking_${index}`]);
      messages.push(entry);
      blocks.push(block({
        id: `blk_export_content_${index}`, messageId: id, blockIndex: 0,
        content: `visible ${index}`,
      }));
      blocks.push(block({
        id: `blk_export_thinking_${index}`, messageId: id, blockIndex: 1,
        blockType: 'thinking', content: `hidden reasoning ${index}`,
      }));
    }

    const selected = selectExportMessages(messages, {
      startMessageId: 'msg_export_1', endMessageId: 'msg_export_2',
    });
    expect(selected.map((entry) => entry.id)).toEqual(['msg_export_1', 'msg_export_2']);

    const markdown = renderSessionMarkdown('Export title', 'sess_export', selected, blocks);
    expect(markdown).toContain('# Export title');
    expect(markdown).toContain('visible 1');
    expect(markdown).toContain('visible 2');
    expect(markdown).not.toContain('visible 0');
    expect(markdown).not.toContain('hidden reasoning');
  });

  it('test_export_range_parser_accepts_stable_message_id_bounds', () => {
    const parsed = parseExportRange({
      range: { start_message_id: 'msg_start', end_message_id: 'msg_end' },
    });
    expect(parsed?.startMessageId).toBe('msg_start');
    expect(parsed?.endMessageId).toBe('msg_end');
    expect(() => parseExportRange({ range: 'all' })).toThrow();
  });

  it('markdown_export_returns_bounded_preview_with_total_character_count', () => {
    const output = markdownExportToToolValue({
      sessionId: 'sess_long_export',
      title: 'Long export',
      markdown: '界'.repeat(MAX_TOOL_FIELD_CHARS + 37),
      messageCount: 3,
      range: null,
    });
    expect([...String(output.markdown)].length).toBe(MAX_TOOL_FIELD_CHARS);
    expect(output.totalChars).toBe(MAX_TOOL_FIELD_CHARS + 37);
    expect(output.truncated).toBe(true);
    expect(output.messageCount).toBe(3);
  });
});
