import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { ToolResultInfo } from '../../chat/api.ts';
import { createManualRun, loadAutomations } from '../repository/automations.ts';
import { AutomationExecutor, describeRelativeTime } from '../src/automation-executor.ts';

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { await cleanup?.(); cleanup = null; });

async function fixture() {
  const host = await createTestHost();
  const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  const db: DatabaseHandle = storage.database('mistakes');
  for (const name of ['V20260714__automation_scheduler.sql', 'V20260715__harden_automation_runtime.sql', 'V20260721__trusted_automation_profile.sql']) {
    db.exec(readFileSync(new URL(`../../../../resources/app/migrations/mistakes/${name}`, import.meta.url), 'utf8'));
  }
  cleanup = async () => { storage.dispose(); await host.dispose(); };
  const changed: [string, string][] = [];
  const executor = new AutomationExecutor({
    database: () => db, runtime: () => { throw new Error('runtime not used'); },
    emitChanged: (action, id) => { changed.push([action, id]); }, warn() {},
  });
  const ctx = {
    session_id: 'sess_origin', block_id: 'blk', main_db: db,
    emitToolCallStart() {}, emitToolCallEnd() {}, emitToolCallError() {}, saveToolBlock(_: ToolResultInfo) {},
  } as never;
  const run = (name: string, args: unknown = {}) => executor.execute({ id: `call_${name}`, name, arguments: args }, ctx);
  return { db, executor, changed, run };
}

const daily = { kind: 'daily', time: '09:30' };

describe('automation_executor.rs AutomationExecutor', () => {
  it('proposes with Rust output shape, then rejects an identical duplicate with a hint', async () => {
    const { run, changed, db } = await fixture();
    const created = await run('builtin-automation_propose', { name: ' 背单词 ', schedule: daily, prompt: '复习 20 个单词' });
    expect(created.success).toBe(true);
    const output = created.output as Record<string, any>;
    expect(Object.keys(output)).toEqual(['status', 'id', 'version', 'name', 'enabled', 'action_type', 'session_mode',
      'model_id', 'schedule', 'schedule_description', 'next_trigger_at', 'next_trigger_relative', 'message', 'storage',
      'previous', 'reversible', 'reversibleWithApproval', 'restoreWith', 'undoReason']);
    expect(output).toMatchObject({ status: 'created', version: 1, name: '背单词', enabled: true, action_type: 'notify',
      session_mode: 'isolated', model_id: null, schedule_description: '每天 09:30',
      restoreWith: { tool: 'automation_delete', arguments: { id: output.id, expected_version: 1 } } });
    expect(output.message).toMatch(/^Automation '背单词' created \(每天 09:30\)\. First run: .+\. At the scheduled time the app will send a system notification/);
    expect(loadAutomations(db)[0]).toMatchObject({ id: output.id, session_id: 'sess_origin' });
    expect(changed).toEqual([['create', output.id]]);

    const duplicate = await run('automation_propose', { name: '背单词', schedule: daily, prompt: '复习 20 个单词' });
    const payload = JSON.parse(duplicate.error!);
    expect(Object.keys(payload)).toEqual(['code', 'errorType', 'message', 'existing', 'retryable', 'hint']);
    expect(payload).toMatchObject({ code: 'AUTOMATION_DUPLICATE', retryable: false,
      message: `An identical automation already exists (id=${output.id}, version=1); not creating a duplicate.` });
    expect((await run('automation_propose', { name: 'x', schedule: daily, prompt: 'y', when: 1 })).error)
      .toBe("Unknown field 'when'. Allowed fields: name, schedule, prompt, enabled, action_type, agent_prompt, session_mode, model_id, catch_up_policy, max_retries, retry_backoff_seconds, timeout_seconds, trusted_profile");
  });

  it('lists with capacity and relative times, and enforces OCC with agent-facing conflict payloads', async () => {
    const { run } = await fixture();
    const id = ((await run('automation_propose', { name: 'n', schedule: daily, prompt: 'p'.repeat(2_100) })).output as any).id;
    expect((await run('automation_list', { x: 1 })).error).toBe('automation_list accepts no arguments');
    const list = (await run('automation_list')).output as Record<string, any>;
    expect(Object.keys(list)).toEqual(['count', 'max', 'automations', 'capacity']);
    expect(list).toMatchObject({ count: 1, max: 20, capacity: '1/20 已使用，还可创建 19 条' });
    expect(list.automations[0]).toMatchObject({ id, promptTruncated: true, fieldsTruncated: ['prompt'], schedule_description: '每天 09:30' });
    expect(list.automations[0].prompt).toHaveLength(2_000);
    expect(typeof list.automations[0].next_trigger_relative).toBe('string');

    const missing = JSON.parse((await run('automation_set_enabled', { id, enabled: false })).error!);
    expect(missing).toMatchObject({ code: 'AUTOMATION_OCC_REQUIRED', requiredField: 'expected_version',
      hint: '先调用 automation_list 拿到该自动化当前的 version，并原样作为 expected_version 传入后重试。' });
    const disabled = (await run('automation_set_enabled', { id, expected_version: 1, enabled: false })).output as Record<string, any>;
    expect(disabled).toMatchObject({ success: true, status: 'disabled', version: 2, next_trigger_at: 'unknown',
      restoreWith: { tool: 'automation_set_enabled', arguments: { id, expected_version: 2, enabled: true } },
      message: "Automation 'n' is now disabled. The scheduler will not trigger it until re-enabled." });

    const conflict = JSON.parse((await run('automation_update', { id, expected_version: 1, name: 'renamed' })).error!);
    expect(conflict).toMatchObject({ code: 'AUTOMATION_VERSION_CONFLICT', errorType: 'conflict', currentVersion: 2,
      current: { promptTruncated: true, fieldsTruncated: ['prompt'] } });
    expect(conflict.current.prompt).toHaveLength(2_000);
    expect(typeof conflict.hint).toBe('string');

    const updated = (await run('automation_update', { id, expected_version: 2, name: 'renamed', max_retries: '3' })).output as Record<string, any>;
    expect(Object.keys(updated)).toEqual(['success', 'automation', 'previous', 'current', 'nextTriggerAt', 'reversible', 'restoreWith', 'undoReason']);
    expect(updated).toMatchObject({ reversible: false, restoreWith: null,
      undoReason: '旧提示词超过 Agent 返回上限，无法在不泄漏/截断内容的情况下生成精确撤销参数', current: { name: 'renamed', max_retries: 3, version: 3 } });
    expect((await run('automation_delete', { id, expected_version: 3 })).output)
      .toMatchObject({ success: true, automationId: id, reversible: false, restoreWith: null, deleted: { id } });
    expect((await run('automation_delete', { id, expected_version: 4 })).error)
      .toMatch(/not found.*。请先用 automation_list（自动化 id）或 automation_runs（运行 id）确认 id 是否存在、是否已被删除。$/);
  });

  it('pages run history, filters status within the page and maps retry/cancel errors to plain messages', async () => {
    const { run, db, changed } = await fixture();
    const id = ((await run('automation_propose', { name: 'n', schedule: daily, prompt: 'p' })).output as any).id;
    const manual = createManualRun(db, id, 1);
    const page = (await run('automation_runs', { automation_id: id, status: 'RUNNING', page_size: 5 })).output as Record<string, any>;
    expect(page).toMatchObject({ returned: 1, total: 1, page: 1, pageSize: 5, hasMore: false, statusFilter: 'running',
      note: 'status filter applied within this page; page through for more matches' });
    expect(page.runs[0]).toMatchObject({ id: manual.run_id, automation_id: id, status: 'running' });
    expect((await run('automation_runs', { status: 'done' })).error)
      .toBe('Invalid status \'done\'. Allowed: queued, running, retrying, success, error, timeout, spawn_error, cancelled, skipped, heartbeat_ok');
    expect((await run('automation_retry_run', { id: manual.run_id })).error).toBe('Run is not retryable');
    expect((await run('automation_cancel_run', { id: manual.run_id })).output).toEqual({ success: true, runId: manual.run_id, reversible: false });
    expect((await run('automation_retry_run', { id: manual.run_id })).output).toEqual({ success: true, runId: manual.run_id, reversible: false });
    expect(changed.slice(-2)).toEqual([['cancel_run', ''], ['retry', '']]);
  });

  it('describes relative times like describe_relative_time and escalates trusted_profile updates', async () => {
    const now = new Date(2026, 10, 7, 10, 0, 0).getTime();
    expect(describeRelativeTime(now - 1, now)).toBe('即将触发');
    expect(describeRelativeTime(now + 30_000, now)).toBe('1 分钟内');
    expect(describeRelativeTime(now + 90 * 60_000, now)).toBe('约 1 小时 30 分钟后');
    expect(describeRelativeTime(new Date(2026, 10, 8, 10, 0).getTime() + 60_000, now)).toBe('明天 10:01');
    expect(describeRelativeTime(new Date(2026, 10, 12, 8, 5).getTime(), now)).toBe('5 天后（11-12 08:05）');
    const { executor } = await fixture();
    expect(executor.sensitivityLevelForCall('automation_update', { trusted_profile: { runtimeRoots: [] } })).toBe('high');
    expect(executor.sensitivityLevelForCall('automation_update', { trusted_profile: null })).toBe('medium');
    expect(['automation_propose', 'automation_run_now', 'automation_runs'].map(name => executor.sensitivityLevel(name)))
      .toEqual(['high', 'medium', 'low']);
  });
});
