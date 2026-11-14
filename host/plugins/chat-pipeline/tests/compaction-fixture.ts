/** Shared compaction fixtures: L04 compaction-table port (repo.rs create/set/get_active) and
 * compaction.rs:2403 seed_compactible_session over the real chat_v2 database. */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { ChatSessionService } from '../../chat/api.ts';

export interface CompactionRow { id: string; summaryMessageId: string; tailStartMessageId: string; rangeEndMessageId: string | null }

export function compactionStorePort(chatSession: ChatSessionService) {
  return {
    createCompactionWithConn(conn: SqlExecutor, record: Record<string, unknown>) {
      conn.run(`INSERT INTO chat_v2_compactions (id, session_id, summary_message_id, tail_start_message_id,
        tail_start_time_created, reason, is_auto, is_overflow, tokens_before, tokens_after, model_id, created_at,
        previous_compaction_id, range_start_message_id, range_end_message_id, compacted_message_count, model_config_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.sessionId, record.summaryMessageId, record.tailStartMessageId, record.tailStartTimeCreated,
        record.reason, record.isAuto ? 1 : 0, record.isOverflow ? 1 : 0, record.tokensBefore, record.tokensAfter,
        record.modelId, record.createdAt, record.previousCompactionId, record.rangeStartMessageId,
        record.rangeEndMessageId, record.compactedMessageCount, record.modelConfigId] as never);
    },
    setSessionLastCompactionWithConn(conn: SqlExecutor, sessionId: string, id: string) {
      conn.run('UPDATE chat_v2_sessions SET last_compaction_id = ? WHERE id = ?', [id, sessionId]);
    },
    getActiveCompactionWithConn(conn: SqlExecutor, sessionId: string): CompactionRow | null {
      return conn.get<CompactionRow>(`SELECT c.id, c.summary_message_id AS summaryMessageId,
        c.tail_start_message_id AS tailStartMessageId, c.range_end_message_id AS rangeEndMessageId
        FROM chat_v2_sessions s JOIN chat_v2_compactions c ON c.id = s.last_compaction_id WHERE s.id = ?`, [sessionId]) ?? null;
    },
    markAvailableSkillsSnapshotStaleWithConn: () => null,
    // Full block rows (tool payloads included), as repo.rs get_message_blocks_with_conn returns them.
    getMessageBlocksWithConn: (_conn: SqlExecutor, messageId: string) =>
      chatSession.getMessageBlocks(messageId).map((block, blockIndex) => ({ ...block, blockIndex })),
  };
}

export function createCompactionSession(chatSession: ChatSessionService, id: string): string {
  chatSession.createSession({ id, mode: 'chat', titleLocked: false, persistStatus: 'active',
    createdAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z' });
  return id;
}

export function seedMessage(chatSession: ChatSessionService, sessionId: string, id: string, role: 'user' | 'assistant',
  timestamp: number, block: { content?: string; toolName?: string; toolInput?: unknown; toolOutput?: unknown }) {
  const blockId = `blk_${id}`;
  chatSession.createMessage({ id, sessionId, role, blockIds: [blockId], timestamp });
  chatSession.createBlock({ id: blockId, messageId: id, type: block.toolName ? 'mcp_tool' : 'content',
    status: 'success', ...block });
}

/** compaction.rs:2403 seed_compactible_session */
export function seedCompactible(chatSession: ChatSessionService, sessionId: string): void {
  let ts = 1_700_000_000_000, seq = 0;
  const turn = (user: string, assistant: string, bigToolChars = 0) => {
    seq += 1; seedMessage(chatSession, sessionId, `msg_e2e_u${seq}`, 'user', ts, { content: user }); ts += 1000;
    seq += 1;
    if (bigToolChars > 0) {
      const unit = 'fn process_frame(idx: usize) -> Result<Frame, RenderError> { /* 渲染管线第N阶段：布局、绘制、合成 */ }';
      const varied = [...unit.repeat(Math.ceil(bigToolChars / [...unit].length))].slice(0, bigToolChars).join('');
      seedMessage(chatSession, sessionId, `msg_e2e_a${seq}`, 'assistant', ts, { toolName: 'workspace_file_read',
        toolInput: { path: '/repo/src/big.rs' }, toolOutput: { content: varied } });
    } else seedMessage(chatSession, sessionId, `msg_e2e_a${seq}`, 'assistant', ts, { content: assistant });
    ts += 1000;
  };
  turn('我想学习 Rust 的所有权机制', '好的，我们从基础开始。');
  turn('什么是借用检查器？', '借用检查器负责在编译期验证引用有效性。');
  for (let t = 2; t <= 4; t++) {
    turn(`第${t}轮：请详细讲解生命周期标注，参见 https://doc.rust-lang.org/book/ch10-03 和 /repo/src/lifetime_${t}.rs`,
      '生命周期标注帮助编译器理解引用的存活范围。'.repeat(40));
  }
  turn('把 big.rs 的内容总结一下', '文件内容如下：', 25_000);
}
