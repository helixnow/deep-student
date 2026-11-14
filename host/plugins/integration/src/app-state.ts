import { Service, type Context } from '@deepseek-ai/cordis';
import { AppError } from '../../../platform/errors/api.ts';
import { CommandError } from '../../../kernel/api.ts';
import { parseRfc3339 } from '../../../platform/time/index.ts';
import { compareUtf8 } from '../../../platform/util/portable.ts';
import {
  appCommandStateService,
  type ActiveDatabaseKind,
  type AppCommandState,
  type TempSessionIdentity,
} from '../api.ts';
import { getTempSessionRecord, upsertTempSession } from '../repository/temp-sessions.ts';
import { cloneStreamContext, type StreamContext } from './stream-context.ts';

/** commands.rs:181. Eviction never deletes the persistent record. */
export const TEMP_SESSION_MEMORY_CAP = 8;

function instantNanos(value: string): bigint {
  const parsed = parseRfc3339(value);
  if (parsed === null) throw new TypeError(`Invalid chrono DateTime: ${value}`);
  return parsed.epochNanos;
}

/** commands.rs:185-200: DateTime comparison, then Rust String's UTF-8 byte order. */
function evictTempSessionsIfOverCap<T extends TempSessionIdentity>(sessions: Map<string, T>): void {
  while (sessions.size > TEMP_SESSION_MEMORY_CAP) {
    let oldest: { id: string; time: bigint } | undefined;
    for (const [id, session] of sessions) {
      const time = instantNanos(session.created_at);
      if (!oldest || time < oldest.time
        || (time === oldest.time
          && compareUtf8(id, oldest.id) < 0)) {
        oldest = { id, time };
      }
    }
    if (!oldest) break;
    sessions.delete(oldest.id);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AppCommandStateService extends Service implements AppCommandState {
  activeDatabase: ActiveDatabaseKind = 'production';
  private readonly tempSessions = new Map<string, StreamContext>();

  constructor(ctx: Context) {
    super(ctx, appCommandStateService.name);
  }

  withTempSessions<R>(operation: (sessions: Map<string, StreamContext>) => R): R {
    // `cache_temp_session` enforces the cap while holding the lock. The callback
    // is synchronous, so eviction runs in the same critical section before the
    // caller regains control, on every exit path (the cap is a map invariant).
    try {
      return operation(this.tempSessions);
    } finally {
      evictTempSessionsIfOverCap(this.tempSessions);
    }
  }

  /** commands.rs:166-171 `persist_temp_session_to_db`. */
  private persistTempSessionToDb(session: StreamContext): void {
    try {
      upsertTempSession(this.ctx.storage, session);
    } catch (error) {
      throw new CommandError(AppError.database(`持久化临时会话失败: ${errorText(error)}`));
    }
  }

  /**
   * commands.rs:248-285 `modify_temp_session`. The tokio mutex sections map to the
   * synchronous map sections below (no await while "locked"); persistence happens
   * after the lock is released, exactly as in Rust.
   */
  async modifyTempSession(tempId: string, mutator: (session: StreamContext) => void): Promise<StreamContext> {
    let updated: StreamContext | undefined;
    {
      const session = this.tempSessions.get(tempId);
      if (session !== undefined) {
        mutator(session);
        updated = cloneStreamContext(session);
      }
    }

    if (updated === undefined) {
      let record: StreamContext | null;
      try {
        record = getTempSessionRecord(this.ctx.storage, tempId);
      } catch (error) {
        throw new CommandError(AppError.database(`读取临时会话失败: ${errorText(error)}`));
      }
      if (record === null) throw new CommandError(AppError.not_found('临时会话不存在'));
      const session = record;
      mutator(session);
      this.withTempSessions((sessions) => {
        sessions.set(tempId, cloneStreamContext(session));
      });
      updated = session;
    }

    this.persistTempSessionToDb(updated);
    return updated;
  }
}
