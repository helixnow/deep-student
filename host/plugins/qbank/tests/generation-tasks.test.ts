import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createMigratedStorage } from './support/storage.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import qbank from '../index.ts';
import { createTask, getTask, isTerminal, markCancelled, markCompleted, markFailed, markRunning,
  parseTaskStatus, recoverInterruptedTasks, saveAuthoringResult, taskView, type GenerationTaskRecord } from '../repository/generation-tasks.ts';
import { GenerationSessions } from '../src/generation-session.ts';

describe('qbank_generation/task_repo.rs', () => {
  it('status_roundtrip_and_terminal', () => {
    for (const status of ['queued', 'running', 'completed', 'failed', 'cancelled'] as const) {
      expect(parseTaskStatus(status)).toBe(status);
    }
    expect(isTerminal('queued')).toBe(false);
    expect(isTerminal('running')).toBe(false);
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
  });

  it('view_omits_request_json_and_stream_event', () => {
    const record: GenerationTaskRecord = {
      id: 'task_1', exam_id: 'exam_1', status: 'completed', request_json: '{"secret":"base64..."}',
      drafts: [], rejected_count: 0, rejection_reasons: [], skipped_references: [], used_reference_count: 0,
      stream_event: 'qbank_generation_stream_x', error: null, created_at: 1, updated_at: 2,
      finished_at: 2, authoring_result: null,
    };
    const view = taskView(record);
    expect(view.id).toBe('task_1');
    expect(view.status).toBe('completed');
    expect(view).not.toHaveProperty('request_json');
    expect(view).not.toHaveProperty('streamEvent');
  });

  it('real SQLite task lifecycle, terminal guards, and restart recovery', async () => {
    const { storage, base } = await createMigratedStorage('qbank-tasks-');
    try {
      const db = storage.database('vfs');
      expect(createTask(db, 't1', 'e1', '{}', 'stream1').status).toBe('queued');
      markRunning(db, 't1');
      expect(getTask(db, 't1')?.status).toBe('running');
      saveAuthoringResult(db, 't1', { job_id: 'job1' });
      markCompleted(db, 't1', [], 2, ['reason'], [], 3);
      const complete = getTask(db, 't1')!;
      expect(complete).toMatchObject({ status: 'completed', rejected_count: 2, rejection_reasons: ['reason'], used_reference_count: 3, authoring_result: { job_id: 'job1' } });
      expect(complete.finished_at).toBe(complete.updated_at);
      markCancelled(db, 't1');
      markFailed(db, 't1', 'late failure');
      markRunning(db, 't1');
      saveAuthoringResult(db, 't1', { job_id: 'late' });
      expect(getTask(db, 't1')).toEqual(complete);
      createTask(db, 't2', 'e1', '{}', 'stream2');
      markCancelled(db, 't2');
      createTask(db, 't3', 'e2', '{}', 'stream3');
      markRunning(db, 't3');
      createTask(db, 't4', 'e2', '{}', 'stream4');
      expect(recoverInterruptedTasks(db)).toBe(2);
      expect(getTask(db, 't2')?.status).toBe('cancelled');
      expect(getTask(db, 't3')?.error).toBe('应用重启导致任务中断，请重新生成');
      expect(getTask(db, 't4')?.status).toBe('failed');
      expect(recoverInterruptedTasks(db)).toBe(0);
    } finally {
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('cancel_generation_session_cancels_registered_token_once', () => {
    let calls = 0;
    const sessions = new GenerationSessions();
    const unregister = sessions.register('stream-x', { cancel: () => { calls += 1; } });
    sessions.cancel('stream-x');
    sessions.cancel('stream-x');
    expect(calls).toBe(1);
    unregister();
  });

  it('cancel_generation_task_marks_only_active_tasks', async () => {
    const { storage, base } = await createMigratedStorage('qbank-task-cancel-');
    const cancelled: string[] = [];
    const host = await createTestHost({
      plugins: [qbank],
      provide: {
        storage,
        paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin',
          env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }),
        llm: {
          requestCancelStream: async (streamEvent: string) => { cancelled.push(streamEvent); },
        },
      },
    });
    try {
      const db = storage.database('vfs');
      createTask(db, 'active', 'e1', '{}', 'stream-active');
      expect(await host.invoke('qbank_cancel_generation_task', { taskId: 'missing' })).toBeNull();
      const active = await host.invoke('qbank_cancel_generation_task', { taskId: 'active' }) as { status: string };
      expect(active.status).toBe('queued');
      expect(getTask(db, 'active')?.status).toBe('cancelled');
      expect(cancelled).toEqual(['stream-active']);
      const replay = await host.invoke('qbank_cancel_generation_task', { taskId: 'active' }) as { status: string };
      expect(replay.status).toBe('cancelled');
      expect(getTask(db, 'active')?.status).toBe('cancelled');
      expect(cancelled).toEqual(['stream-active']);
    } finally {
      await host.dispose();
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('get/list command contracts, descending creation order, default/capped/zero limits, and database errors', async () => {
    const { storage, base } = await createMigratedStorage('qbank-task-commands-');
    const host = await createTestHost({
      plugins: [qbank],
      provide: {
        storage,
        paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin',
          env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }),
      },
    });
    try {
      const db = storage.database('vfs');
      for (let i = 0; i < 105; i++) {
        createTask(db, `t${i}`, 'e1', '{"private":true}', 'secret-stream');
        db.run('UPDATE qbank_generation_tasks SET created_at=? WHERE id=?', [i, `t${i}`]);
      }
      createTask(db, 'other', 'e2', '{}', 'other-stream');
      expect(await host.invoke('qbank_get_generation_task', { taskId: 'missing' })).toBeNull();
      const view = await host.invoke('qbank_get_generation_task', { taskId: 't2' });
      expect(view).toMatchObject({ id: 't2', examId: 'e1', status: 'queued', drafts: [], error: null, authoringResult: null });
      expect(view).not.toHaveProperty('request_json');
      expect(view).not.toHaveProperty('streamEvent');
      const defaults = await host.invoke('qbank_list_generation_tasks', { examId: 'e1' }) as { id: string }[];
      expect(defaults).toHaveLength(20);
      expect(defaults[0]?.id).toBe('t104');
      expect(await host.invoke('qbank_list_generation_tasks', { examId: 'e1', limit: 1000 })).toHaveLength(100);
      expect(await host.invoke('qbank_list_generation_tasks', { examId: 'e1', limit: 0 })).toEqual([]);
      db.exec('DROP TABLE qbank_generation_tasks');
      await expect(host.invoke('qbank_get_generation_task', { taskId: 't2' })).rejects.toEqual({
        error_type: 'Database', message: 'Database error: 出题任务表操作失败: no such table: qbank_generation_tasks', details: null,
      });
    } finally {
      await host.dispose();
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
