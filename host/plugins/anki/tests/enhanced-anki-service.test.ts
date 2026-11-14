/**
 * `crates/dstu-anki/src/enhanced_anki_service.rs::tests` 中已可独立验证的用例。
 *
 * `update_anki_card` 的卡墓碑 / 父任务墓碑拒绝逻辑已由命令 + repository 完整接线
 * （`repository/anki-cards.ts::updateCardRows` 同时过滤 `anki_cards.deleted_at`
 * 与父 `document_tasks.deleted_at`），因此这条不依赖 streaming/LLM 的用例先行移植。
 * 其余 4 条依赖 L02 流式生成面的用例保留 pending。
 */
import { describe, expect, it } from 'vitest';
import type { AnkiCard, DocumentTask } from '../../../../contracts/ipc/generated/_shared.ts';
import type { FsrsEnqueueResult } from '../../../../contracts/ipc/generated/L15-review-analytics.ts';
import type { AnkiGenerationOptions } from '../../../../contracts/ipc/generated/L16-anki.ts';
import { saveDocumentTaskWithCardsAtomic } from '../repository/anki-cards.ts';
import { DocumentProcessingService } from '../src/document-processing.ts';
import {
  DocumentRunRegistry,
  deleteDocumentSessionLifecycle,
  registerRunningTask,
  releaseRunningTask,
  triggerTaskProcessing,
  type EnhancedServiceDeps,
  type ReviewEnqueuePort,
  enqueueDocumentCards,
  fsrsFeedbackAuthorized,
  testPauseNoEmit,
  testResumeNoEmit,
} from '../src/enhanced-service.ts';
import type { StreamingAnkiService } from '../src/streaming-anki.ts';
import { createAnkiTestEnv } from './env.ts';

function task(): DocumentTask {
  const now = '2026-08-24T00:00:00+00:00';
  return {
    id: 'task-visible-update',
    document_id: 'doc-visible-update',
    original_document_name: 'visible update',
    segment_index: 0,
    content_segment: 'fixture',
    status: 'Completed',
    created_at: now,
    updated_at: now,
    error_message: null,
    anki_generation_options_json: '{}',
  };
}

function card(id: string, front: string): AnkiCard {
  const now = '2026-08-24T00:00:00+00:00';
  return {
    id,
    task_id: 'task-visible-update',
    front,
    back: 'answer',
    text: null,
    tags: [],
    images: [],
    is_error_card: false,
    error_content: null,
    created_at: now,
    updated_at: now,
    extra_fields: {},
    template_id: null,
  };
}

describe('crates/dstu-anki/src/enhanced_anki_service.rs::tests', () => {
  it('user_visible_card_update_rejects_card_and_parent_tombstones', async () => {
    // Rust 原例 only migrate_single(Mistakes) + with_audit_db(None)；其它文件保持四库默认。
    const env = await createAnkiTestEnv({ migrationScope: ['mistakes'] });
    try {
      const db = env.storage.database('mistakes');
      const seededTask = task();
      saveDocumentTaskWithCardsAtomic(db, seededTask, [
        card('card-visible-tombstone', 'original card'),
        card('card-parent-tombstone', 'original parent card'),
      ]);

      // 活卡可以更新（对照组，避免墓碑断言空洞通过）。
      await expect(
        env.host.invoke('update_anki_card', {
          card: { ...card('card-visible-tombstone', 'live update') },
        }),
      ).resolves.toBeNull();
      expect(
        db.pluck<string>('SELECT front FROM anki_cards WHERE id = ?1', [
          'card-visible-tombstone',
        ]),
      ).toBe('live update');

      const now = '2026-08-24T02:00:00+00:00';
      db.run('UPDATE anki_cards SET deleted_at = ?1 WHERE id = ?2', [
        now,
        'card-visible-tombstone',
      ]);
      await expect(
        env.host.invoke('update_anki_card', {
          card: { ...card('card-visible-tombstone', 'must not update card tombstone') },
        }),
      ).rejects.toMatchObject({ error_type: 'NotFound' });

      db.run('UPDATE document_tasks SET deleted_at = ?1 WHERE id = ?2', [now, seededTask.id]);
      await expect(
        env.host.invoke('update_anki_card', {
          card: { ...card('card-parent-tombstone', 'must not update parent tombstone') },
        }),
      ).rejects.toMatchObject({ error_type: 'NotFound' });
    } finally {
      await env.dispose();
    }
  });

  it('migration_scope_limits_fixture_to_mistakes_and_reverifies_the_copy', async () => {
    const env = await createAnkiTestEnv({ migrationScope: ['mistakes'] });
    try {
      expect(env.storage.migrations.currentVersion('mistakes')).toBeGreaterThan(0);
      expect(env.storage.migrations.currentVersion('vfs')).toBe(0);
      expect(env.migrationReports).toEqual([
        expect.objectContaining({ id: 'mistakes', appliedCount: 0, success: true }),
      ]);
    } finally {
      await env.dispose();
    }
  });

  function options(): AnkiGenerationOptions {
    return {
      deck_name: 'Default',
      note_type: 'Basic',
      enable_images: false,
      max_cards_per_mistake: 2,
      segment_overlap_size: 200,
    };
  }

  function depsFor(
    db: Parameters<typeof saveDocumentTaskWithCardsAtomic>[0],
    registry: DocumentRunRegistry,
    fsrsOwner: EnhancedServiceDeps['fsrsOwner'],
  ): EnhancedServiceDeps {
    const streaming = {
      async cancelStreaming() {},
      async clearCancelSender() {},
      async isStreaming() {
        return false;
      },
    } as unknown as StreamingAnkiService;
    return {
      db,
      registry,
      streaming,
      fsrsOwner,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    };
  }

  function enqueueResult(enqueued: number, skipped: number, ids: string[]): FsrsEnqueueResult {
    return {
      enqueued,
      skipped,
      enqueuedStateIds: ids.slice(0, enqueued).map((id) => `state-${id}`),
      states: [],
      reviewCards: [],
    };
  }

  it('fsrs_feedback_requires_explicit_opt_in', () => {
    expect(fsrsFeedbackAuthorized(null)).toBe(false);
    expect(fsrsFeedbackAuthorized(false)).toBe(false);
    expect(fsrsFeedbackAuthorized(true)).toBe(true);
  });

  it('test_pause_marks_first_task_paused_without_streaming', async () => {
    const env = await createAnkiTestEnv();
    try {
      const db = env.storage.database('mistakes');
      const processor = new DocumentProcessingService(db);
      const [documentId] = await processor.processDocumentAndCreateTasks(
        '这是一段用于测试的文档内容。',
        '测试文档',
        options(),
      );
      const registry = new DocumentRunRegistry();
      registry.entry(documentId);
      testPauseNoEmit(depsFor(db, registry, env.host.ctx.review), documentId);

      const tasks = processor.getDocumentTasks(documentId);
      expect(tasks.some((task) => task.status === 'Paused')).toBe(true);
    } finally {
      await env.dispose();
    }
  });

  it('test_resume_unpauses_document_and_pending_exists', async () => {
    const env = await createAnkiTestEnv();
    try {
      const db = env.storage.database('mistakes');
      const processor = new DocumentProcessingService(db);
      const [documentId] = await processor.processDocumentAndCreateTasks(
        'resume test content',
        '测试文档2',
        options(),
      );
      const registry = new DocumentRunRegistry();
      registry.entry(documentId);
      const deps = depsFor(db, registry, env.host.ctx.review);
      testPauseNoEmit(deps, documentId);
      testResumeNoEmit(deps, documentId);

      expect(registry.get(documentId)?.paused).toBe(false);
      const tasks = processor.getDocumentTasks(documentId);
      expect(tasks.some((task) => task.status === 'Pending')).toBe(true);
      expect(tasks.every((task) => task.status !== 'Paused')).toBe(true);
    } finally {
      await env.dispose();
    }
  });

  it('generated_cards_are_enqueued_once_and_error_cards_are_skipped', async () => {
    const env = await createAnkiTestEnv();
    try {
      const db = env.storage.database('mistakes');
      const seededTask = {
        ...task(),
        id: 'task-auto-enqueue',
        document_id: 'doc-auto-enqueue',
        original_document_name: 'auto enqueue',
      };
      const makeCard = (id: string, isError: boolean): AnkiCard => ({
        ...card(id, `front ${id}`),
        task_id: seededTask.id,
        is_error_card: isError,
      });
      saveDocumentTaskWithCardsAtomic(db, seededTask, [
        makeCard('card-a', false),
        makeCard('card-b', false),
        makeCard('card-err', true),
      ]);

      const seen = new Set<string>();
      const received: string[][] = [];
      const review: ReviewEnqueuePort = {
        enqueueCards(cardIds) {
          received.push([...cardIds]);
          const fresh = cardIds.filter((id) => !seen.has(id));
          for (const id of fresh) seen.add(id);
          return enqueueResult(fresh.length, cardIds.length - fresh.length, cardIds);
        },
      };

      const first = enqueueDocumentCards(db, 'doc-auto-enqueue', review);
      expect(first).not.toBeNull();
      expect(first!.enqueued).toBe(2);
      expect(received[0]).toEqual(['card-a', 'card-b']);

      const second = enqueueDocumentCards(db, 'doc-auto-enqueue', review);
      expect(second).not.toBeNull();
      expect(second!.enqueued).toBe(0);
      expect(second!.skipped).toBe(2);
    } finally {
      await env.dispose();
    }
  });

  it('pause_command_marks_running_task_paused_and_emits_events', async () => {
    const env = await createAnkiTestEnv();
    try {
      const db = env.storage.database('mistakes');
      const processor = new DocumentProcessingService(db);
      const [documentId] = await processor.processDocumentAndCreateTasks(
        'pause command content',
        '暂停命令测试',
        options(),
      );
      const task = processor.getDocumentTasks(documentId)[0]!;
      processor.updateTaskStatus(task.id, 'Processing', null);

      await env.host.invoke('pause_document_processing', { documentId });

      expect(processor.getDocumentTasks(documentId)[0]!.status).toBe('Paused');
      expect(await env.host.invoke('get_document_processing_state', { documentId })).toEqual({
        paused: true,
        current_task_id: null,
      });
      const payloads = env.host.eventsNamed('anki_generation_event') as Array<Record<string, unknown>>;
      expect(payloads.some((payload) => 'DocumentProcessingPaused' in payload)).toBe(true);
      expect(
        payloads.some((payload) => {
          const update = payload['TaskStatusUpdate'] as Record<string, unknown> | undefined;
          return update?.['task_id'] === task.id && update['status'] === 'Paused';
        }),
      ).toBe(true);
    } finally {
      await env.dispose();
    }
  });

  it('cancel_command_rejects_empty_document_id_and_marks_tasks_cancelled', async () => {
    const env = await createAnkiTestEnv();
    try {
      await expect(
        env.host.invoke('cancel_document_processing', { documentId: '' }),
      ).rejects.toMatchObject({ error_type: 'Validation', message: '文档ID不能为空' });

      const db = env.storage.database('mistakes');
      const processor = new DocumentProcessingService(db);
      const [documentId] = await processor.processDocumentAndCreateTasks(
        'cancel command content',
        '取消命令测试',
        options(),
      );
      await env.host.invoke('cancel_document_processing', { documentId });

      expect(processor.getDocumentTasks(documentId).every((task) => task.status === 'Cancelled')).toBe(true);
      expect(await env.host.invoke('get_document_processing_state', { documentId })).toEqual({
        paused: false,
        current_task_id: null,
      });
      const payloads = env.host.eventsNamed('anki_generation_event') as Array<Record<string, unknown>>;
      expect(payloads.some((payload) => 'DocumentProcessingCancelled' in payload)).toBe(true);
    } finally {
      await env.dispose();
    }
  });

  it('trigger_rejects_non_retryable_status_before_the_running_handle_branch', async () => {
    const env = await createAnkiTestEnv();
    try {
      const db = env.storage.database('mistakes');
      const processor = new DocumentProcessingService(db);
      const [, tasks] = await processor.processDocumentAndCreateTasks(
        'trigger order content',
        'trigger order',
        options(),
      );
      const task = tasks[0]!;
      processor.updateTaskStatus(task.id, 'Processing', null);
      const handle = registerRunningTask(task.id);
      try {
        const deps: EnhancedServiceDeps = {
          ...depsFor(db, new DocumentRunRegistry(), env.host.ctx.review),
          generation: {
            async processTaskAndGenerateCardsStream() {
              throw new Error('must not run');
            },
          },
        };
        await expect(
          triggerTaskProcessing(deps, task.id, { emit() {} }),
        ).rejects.toMatchObject({ message: '任务状态不是待处理' });

        // 状态可重试但运行句柄仍在：第二道防重入分支。
        processor.updateTaskStatus(task.id, 'Pending', null);
        await expect(
          triggerTaskProcessing(deps, task.id, { emit() {} }),
        ).rejects.toMatchObject({ message: '任务正在处理中，请勿重复触发' });
      } finally {
        releaseRunningTask(handle);
      }
    } finally {
      await env.dispose();
    }
  });

  it('delete_document_session_epoch_invalidates_and_aborts_on_cancel_failure', async () => {
    const env = await createAnkiTestEnv();
    try {
      const db = env.storage.database('mistakes');
      const processor = new DocumentProcessingService(db);
      const [documentId, tasks] = await processor.processDocumentAndCreateTasks(
        'delete lifecycle content',
        '删除生命周期测试',
        options(),
      );
      const task = tasks[0]!;
      processor.updateTaskStatus(task.id, 'Streaming', null);

      const registry = new DocumentRunRegistry();
      const entry = registry.entry(documentId);
      entry.epoch = 7;
      entry.running = true;
      entry.current_task_id = task.id;
      // 取消通道未注册：删除路径必须 abort 独立运行句柄，而不是只删 ID。
      const handle = registerRunningTask(task.id);
      let cancelCalls = 0;
      const deps: EnhancedServiceDeps = {
        db,
        registry,
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        fsrsOwner: env.host.ctx.review,
        streaming: {
          async cancelStreaming() {
            cancelCalls += 1;
            expect(registry.get(documentId)).toMatchObject({
              paused: true,
              running: false,
              epoch: 8,
            });
            throw new Error('cancel channel missing');
          },
          async clearCancelSender() {},
          async isStreaming() { return false; },
        },
      };

      await deleteDocumentSessionLifecycle(deps, documentId);

      expect(cancelCalls).toBe(1);
      expect(handle.signal.aborted).toBe(true);
      releaseRunningTask(handle);
      expect(registry.get(documentId)).toBeUndefined();
      expect(processor.getDocumentTasks(documentId)).toEqual([]);
    } finally {
      await env.dispose();
    }
  });

  it('get_document_processing_state_defaults_for_unknown_document', async () => {
    const env = await createAnkiTestEnv();
    try {
      expect(
        await env.host.invoke('get_document_processing_state', { documentId: 'doc-never-seen' }),
      ).toEqual({ paused: false, current_task_id: null });
    } finally {
      await env.dispose();
    }
  });
});
