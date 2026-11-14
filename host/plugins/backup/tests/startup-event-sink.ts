/**
 * V03-02 方案 A：启动期迁移状态 / 可恢复任务只派发给 Host 内部（Cordis）监听者。
 * 同时用 `ctx.backendEvents.listen` 记录是否有任何一条经 webview 通道发出。
 */
import { expect } from 'vitest';
import type { TestHost } from '../../../kernel/testing.ts';
import { BACKUP_JOBS_RESUMABLE_EVENT, MIGRATION_STATUS_EVENT } from '../src/startup-events.ts';

export interface StartupEventSink {
  migration: Array<Record<string, unknown>>;
  resumable: unknown[];
  backend: Array<{ event: string; payload: unknown }>;
}

/** 必须在 `runStartupFinalizers()` 之前调用。 */
export function startupEventSink(host: TestHost): StartupEventSink {
  const sink: StartupEventSink = { migration: [], resumable: [], backend: [] };
  host.ctx.on(MIGRATION_STATUS_EVENT, payload => { sink.migration.push(payload); });
  host.ctx.on(BACKUP_JOBS_RESUMABLE_EVENT, jobs => { sink.resumable.push(jobs); });
  for (const event of [MIGRATION_STATUS_EVENT, BACKUP_JOBS_RESUMABLE_EVENT]) {
    host.ctx.backendEvents.listen(event, payload => { sink.backend.push({ event, payload }); });
  }
  return sink;
}

export function expectNothingSentToWebview(host: TestHost, sink: StartupEventSink): void {
  expect(sink.backend).toEqual([]);
  expect(host.eventsNamed(MIGRATION_STATUS_EVENT)).toEqual([]);
  expect(host.eventsNamed(BACKUP_JOBS_RESUMABLE_EVENT)).toEqual([]);
}
