import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createPipelineHost } from './chat-host.ts';
import {
  insertConnectorDraft, markConnectorConfirmed, markConnectorSubmitting, markConnectorOutcomeUnknown,
} from '../../agent-skills/api.ts';
import type { MessageBlock } from '../../chat/api.ts';
import { ChatV2Error } from '../../chat/api.ts';

async function harness(sessionId: string, blockId: string) {
  const host = await createPipelineHost();
  const sessions = host.ctx.chatSession;
  sessions.createSession({ id: sessionId, mode: 'general_chat', titleLocked: false,
    persistStatus: 'active', createdAt: '2026-09-07T00:00:00Z', updatedAt: '2026-09-07T00:00:00Z' });
  const execution = host.ctx.chatPipeline.createPipelineContext({ sessionId, content: 'hi' });
  const output = { task_completed: true, result: 'done' };
  sessions.createMessage({ id: execution.assistantMessageId, sessionId,
    role: 'assistant', blockIds: [blockId], timestamp: 0 });
  const block: MessageBlock = { id: blockId, messageId: execution.assistantMessageId,
    type: 'mcp_tool', status: 'success', toolName: 'builtin-attempt_completion', toolOutput: structuredClone(output) };
  sessions.createBlock(block);
  execution.toolResults.push({ toolName: 'builtin-attempt_completion', toolCallId: 'complete',
    blockId, input: { result: 'done' }, output, success: true });
  execution.interleavedBlocks.push(block);
  return { host, sessions, execution, blockId };
}

describe('finalizer.rs::completion wiring', () => {
  it('settings_resolve_limits_valid_and_invalid: service reads live platform settings', async () => {
    const host = await createPipelineHost();
    try {
      host.ctx.settings.save('headless_budget_max_tokens', '9007199254740993');
      expect(host.ctx.chatPipeline.effectiveBudgetLimits().maxTokens).toBe(9_007_199_254_740_993n);
      host.ctx.settings.save('headless_budget_max_tokens', '42');
      expect(host.ctx.chatPipeline.effectiveBudgetLimits().maxTokens).toBe(42);
    } finally { await host.dispose(); }
  });
  it('test_chat_v2_error_types', () => {
    expect(new ChatV2Error('Cancelled').toString()).toBe('Cancelled');
    expect(new ChatV2Error('Llm', 'LLM 调用失败').toString()).toContain('LLM');
    expect(new ChatV2Error('Tool', '工具执行失败').toString()).toContain('工具');
  });
  it('try_finalize_writes_report_into_completion_block_and_db', async () => {
    const { host, sessions, execution, blockId } = await harness('sess-finalizer', 'blk_completion_e2e');
    try {
      const report = host.ctx.chatPipeline.tryFinalizeTaskCompletion(execution);
      expect(report?.verdict).toBe('verified_complete');
      expect(execution.toolResults[0]!.output).toMatchObject({ finalization: { verdict: 'verified_complete' } });
      expect(execution.interleavedBlocks[0]!.toolOutput).toMatchObject({ finalization: { verdict: 'verified_complete' } });
      expect(sessions.getBlock(blockId)?.toolOutput).toMatchObject({ finalization: { verdict: 'verified_complete' } });
      expect(execution.dirtyInterleavedBlockIds.has(blockId)).toBe(true);
    } finally { await host.dispose(); }
  });

  it('g07b_try_finalize_reads_connector_ledger_pending_ops', async () => {
    const { host, sessions, execution } = await harness('sess-g07b-ledger', 'blk_completion_ledger');
    try {
      const db = sessions.database.getConnSafe();
      const hash = 'a'.repeat(64);
      insertConnectorDraft(db, { operationId: 'op-e2e', sessionId: execution.sessionId,
        providerId: 'google-work', capability: 'mail', action: 'send', previewSha256: hash,
        idempotencyKey: createHash('sha256').update(`op-e2e${hash}`).digest('hex'),
        accountId: null, capabilityFingerprint: null, previewJson: '{}', expiresAtMs: null,
        createdAt: '2026-09-07T00:00:00Z' });
      markConnectorConfirmed(db, 'op-e2e', hash, 't1');
      markConnectorSubmitting(db, 'op-e2e', 't2', 'h');
      markConnectorOutcomeUnknown(db, 'op-e2e', 'transient');
      const report = host.ctx.chatPipeline.tryFinalizeTaskCompletion(execution)!;
      expect(report.verdict).toBe('outcome_unknown');
      expect(report.checks_run).toEqual(['side_effects_settled']);
      expect(report.exceptions).toHaveLength(1);
      expect(report.exceptions[0]!.kind).toBe('side_effect_pending');
      expect(report.exceptions[0]!.message).toContain('op-e2e');
    } finally { await host.dispose(); }
  });
});
