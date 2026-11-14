import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createPipelineHost } from './chat-host.ts';

describe('R2 P2: budget hot paths through the production plugin', () => {
  it('settings_read_from_main_db_file: absent parent does not create directories and warns at open', async () => {
    const host = await createPipelineHost();
    try {
      const parent = join(dirname(host.ctx.chatSession.database.dbPath()), `absent_${randomUUID()}`);
      const file = join(parent, 'mistakes.db');
      const open = vi.spyOn(host.ctx.storage, 'openFile');
      const warn = vi.spyOn(host.ctx.logger, 'warn');
      expect(existsSync(parent)).toBe(false);
      expect(host.ctx.chatPipeline.readBudgetSettingFromFile(file, 'headless_budget_max_tokens')).toBeNull();
      expect(existsSync(parent)).toBe(false);
      expect(open).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledExactlyOnceWith(`[Budget] 打开主库 settings 失败（${file}），key 'headless_budget_max_tokens' 回退默认: unable to open database file: ${file}`);
      open.mockRestore();
      warn.mockRestore();
    } finally { await host.dispose(); }
  });
  it('snapshot_persist_and_restore_roundtrip: restores at installation, persists only Rust write points', async () => {
    const restoredRoot = `restored_${randomUUID()}`;
    const host = await createPipelineHost({ setupStorage(storage) {
      const db = storage.database('chat_v2');
      db.run('INSERT INTO budget_snapshots (root_id, limits_json, usage_json, updated_at) VALUES (?, ?, ?, ?)', [
        restoredRoot, JSON.stringify({ maxToolCalls: 3, maxTokens: 100, maxWallClockSecs: 3600 }),
        JSON.stringify({ toolCalls: 1, tokensIn: 2, tokensOut: 3, wallClockSecs: 0,
          createdAtUnix: Math.floor(Date.now() / 1000) }), 'old',
      ]);
    } });
    try {
      const pipeline = host.ctx.chatPipeline;
      const db = host.ctx.chatSession.database.getConnSafe();
      expect(pipeline.budgetLedgerForTree(restoredRoot)?.usage().toolCalls).toBe(1);
      const root = `persist_${randomUUID()}`;
      const read = () => JSON.parse(db.get<{ usage_json: string }>(
        'SELECT usage_json FROM budget_snapshots WHERE root_id = ?', [root])!.usage_json) as { toolCalls: number; tokensIn: number };
      const binding = pipeline.attachChildToTree(root, 'worker_lifecycle', null,
        { maxToolCalls: 2, maxTokens: 10, maxWallClockSecs: 3600 });
      expect(read().toolCalls).toBe(0);
      expect(pipeline.tryConsumeTreeBudget(root, { toolCalls: 1, tokensIn: 0, tokensOut: 0 }).ok).toBe(true);
      expect(read().toolCalls).toBe(0);
      binding.release();
      expect(read().toolCalls).toBe(1);
      expect(pipeline.tryConsumeTreeBudget(root, { toolCalls: 2, tokensIn: 0, tokensOut: 0 }).ok).toBe(false);
      expect(read().toolCalls).toBe(1);
      pipeline.recordTreeUsage(root, { toolCalls: 0, tokensIn: 11, tokensOut: 0 });
      expect(read().tokensIn).toBe(11);
      const write = vi.spyOn(db, 'run');
      expect(pipeline.tryConsumeTreeBudget(root, { toolCalls: 1, tokensIn: 0, tokensOut: 0 }).ok).toBe(false);
      expect(write).not.toHaveBeenCalled();
      write.mockRestore();
      const next = pipeline.attachChildToTree(root, 'worker_next', null,
        { maxToolCalls: 2, maxTokens: 10, maxWallClockSecs: 3600 });
      expect(read().tokensIn).toBe(0);
      expect(read().toolCalls).toBe(0);
      next.release();
    } finally { await host.dispose(); }
  });

  it('snapshot_restore_tolerates_missing_table_and_bad_rows: failed writes warn and retry without changing admission', async () => {
    const host = await createPipelineHost();
    try {
      const root = `retry_snapshot_${randomUUID()}`;
      const db = host.ctx.chatSession.database.getConnSafe();
      const pipeline = host.ctx.chatPipeline;
      const warn = vi.spyOn(host.ctx.logger, 'warn');
      const write = vi.spyOn(db, 'run').mockImplementationOnce(() => { throw new Error('disk full'); });
      const attachment = pipeline.attachChildToTree(root, 'worker_write_retry', null,
        { maxToolCalls: 1, maxTokens: 5, maxWallClockSecs: 3600 });
      expect(warn).toHaveBeenCalledWith(`[Budget] snapshot persist failed (root=${root}): budget_snapshots upsert failed (root=${root}): disk full`);
      expect(db.get('SELECT root_id FROM budget_snapshots WHERE root_id = ?', [root])).toBeUndefined();
      expect(pipeline.tryConsumeTreeBudget(root, { toolCalls: 1, tokensIn: 0, tokensOut: 0 }).ok).toBe(true);
      expect(pipeline.tryConsumeTreeBudget(root, { toolCalls: 1, tokensIn: 0, tokensOut: 0 }).ok).toBe(false);
      expect(JSON.parse(db.get<{ usage_json: string }>('SELECT usage_json FROM budget_snapshots WHERE root_id = ?', [root])!.usage_json).toolCalls).toBe(1);
      expect(write).toHaveBeenCalledTimes(2);
      attachment.release();
      expect(write).toHaveBeenCalledTimes(2);
      write.mockRestore();
      warn.mockRestore();
    } finally { await host.dispose(); }
  });
});
