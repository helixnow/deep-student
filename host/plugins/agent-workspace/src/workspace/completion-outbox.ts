// workspace/completion_outbox.rs —— 子代理完成投递持久账本（chat_v2 主库）。
import type { SqlExecutor } from '../../../../platform/storage/api.ts';
import { nowEpochNanos, toRfc3339Opts } from '../../../../platform/time/index.ts';
import * as outboxSql from '../../repository/completion-outbox-repository.ts';
import type { CompletionOutboxRow } from '../../repository/completion-outbox-repository.ts';

export type CompletionDeliveryState = 'pending' | 'claimed' | 'delivered' | 'expired';

export const COMPLETION_DELIVERY_STATES: readonly CompletionDeliveryState[] = [
  'pending', 'claimed', 'delivered', 'expired',
];

export function parseCompletionDeliveryState(raw: string): CompletionDeliveryState | null {
  return COMPLETION_DELIVERY_STATES.find(state => state === raw) ?? null;
}

/** `completion_outbox` 表的完整行。 */
export interface CompletionDelivery {
  deliveryId: string;
  taskId: string | null;
  runId: string;
  workspaceId: string;
  agentSessionId: string;
  targetSessionId: string;
  targetGeneration: string | null;
  payloadJson: string;
  state: CompletionDeliveryState;
  claimOwner: string | null;
  claimExpiry: string | null;
  attemptCount: number;
  createdAt: string;
  deliveredAt: string | null;
}

/** 新建投递的写入参数。 */
export interface NewCompletionDelivery {
  deliveryId: string;
  taskId: string | null;
  runId: string;
  workspaceId: string;
  agentSessionId: string;
  targetSessionId: string;
  targetGeneration: string | null;
  payloadJson: string;
  createdAt: string;
}

/**
 * 固定毫秒宽度的时间戳：等宽 RFC3339 的字典序与时间序一致，
 * claim 的 created_at 宽限期比较与 claim_expiry 过期比较依赖该性质。
 */
export function nowCompletionTimestamp(): string {
  return toRfc3339Opts(nowEpochNanos(), 'Millis', true);
}

/** enqueue 结果：插入成功，或同 run_id 行已存在（幂等命中）。 */
export type EnqueueOutcome = 'inserted' | 'duplicate_run';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rowToDelivery(row: CompletionOutboxRow): CompletionDelivery {
  const state = parseCompletionDeliveryState(row.state);
  if (state === null) {
    throw new Error(`failed to read completion delivery: invalid state: ${row.state}`);
  }
  return {
    deliveryId: row.delivery_id,
    taskId: row.task_id,
    runId: row.run_id,
    workspaceId: row.workspace_id,
    agentSessionId: row.agent_session_id,
    targetSessionId: row.target_session_id,
    targetGeneration: row.target_generation,
    payloadJson: row.payload_json,
    state,
    claimOwner: row.claim_owner,
    claimExpiry: row.claim_expiry,
    attemptCount: Number(row.attempt_count),
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  };
}

/** 完成投递账本 repo。所有状态迁移以单条原子 UPDATE 完成。 */
export class CompletionOutbox {
  private readonly connection: SqlExecutor | (() => SqlExecutor);

  constructor(connection: SqlExecutor | (() => SqlExecutor)) {
    this.connection = connection;
  }

  /** Rust borrows ChatV2Database.get_conn() per operation; never retain a replaced slot handle. */
  private get db(): SqlExecutor {
    return typeof this.connection === 'function' ? this.connection() : this.connection;
  }

  /**
   * 完成事实入帐（pending）。`run_id` 唯一：重复入帐静默命中
   * `duplicate_run`，不产生第二行。
   */
  enqueue(entry: NewCompletionDelivery): EnqueueOutcome {
    let changed: number;
    try {
      changed = outboxSql.enqueueCompletion(this.db, {
        deliveryId: entry.deliveryId,
        taskId: entry.taskId,
        runId: entry.runId,
        workspaceId: entry.workspaceId,
        agentSessionId: entry.agentSessionId,
        targetSessionId: entry.targetSessionId,
        targetGeneration: entry.targetGeneration,
        payloadJson: entry.payloadJson,
        createdAt: entry.createdAt,
      });
    } catch (error) {
      throw new Error(`failed to enqueue completion delivery: ${messageOf(error)}`);
    }
    return changed === 1 ? 'inserted' : 'duplicate_run';
  }

  get(deliveryId: string): CompletionDelivery | null {
    return this.readRow(
      () => outboxSql.getCompletion(this.db, deliveryId),
      'failed to read completion delivery',
    );
  }

  getByRunId(runId: string): CompletionDelivery | null {
    return this.readRow(
      () => outboxSql.getCompletionByRunId(this.db, runId),
      'failed to read completion delivery by run_id',
    );
  }

  /** 闭包自投递成功后收敛：pending|claimed → delivered。 */
  markDeliveredByDeliveryId(deliveryId: string): boolean {
    try {
      const changed = outboxSql.markCompletionDeliveredByDeliveryId(
        this.db, deliveryId, nowCompletionTimestamp(),
      );
      return changed === 1;
    } catch (error) {
      throw new Error(`failed to mark completion delivered: ${messageOf(error)}`);
    }
  }

  /** 回收过期租约（claimed 且 claim_expiry 已过 → pending）。 */
  reclaimExpiredClaims(): number {
    try {
      return outboxSql.reclaimExpiredCompletionClaims(this.db, nowCompletionTimestamp());
    } catch (error) {
      throw new Error(`failed to reclaim expired completion claims: ${messageOf(error)}`);
    }
  }

  /** 原子认领一批 pending 行（`not_before` 为在途闭包自投递宽限期）。 */
  claimPending(owner: string, leaseExpiry: string, notBefore: string, limit: number): CompletionDelivery[] {
    let rows: CompletionOutboxRow[];
    try {
      rows = outboxSql.claimPendingCompletions(this.db, owner, leaseExpiry, notBefore, limit);
    } catch (error) {
      throw new Error(`failed to claim pending completions: ${messageOf(error)}`);
    }
    return rows.map(rowToDelivery);
  }

  /** 处理暂缓：归还租约回 pending（owner 守卫）。 */
  releaseClaim(deliveryId: string, owner: string): boolean {
    try {
      return outboxSql.releaseCompletionClaim(this.db, deliveryId, owner) === 1;
    } catch (error) {
      throw new Error(`failed to release completion claim: ${messageOf(error)}`);
    }
  }

  /** 投递完成（owner 守卫）：claimed → delivered。 */
  markDelivered(deliveryId: string, owner: string): boolean {
    try {
      return outboxSql.markCompletionDelivered(
        this.db, deliveryId, owner, nowCompletionTimestamp(),
      ) === 1;
    } catch (error) {
      throw new Error(`failed to mark completion delivered: ${messageOf(error)}`);
    }
  }

  /** 目标失效：pending 或本 owner 的 claimed → expired。 */
  markExpired(deliveryId: string, owner: string | null): boolean {
    try {
      return outboxSql.markCompletionExpired(this.db, deliveryId, owner) === 1;
    } catch (error) {
      throw new Error(`failed to expire completion delivery: ${messageOf(error)}`);
    }
  }

  private readRow(
    run: () => CompletionOutboxRow | undefined,
    prefix: string,
  ): CompletionDelivery | null {
    let row: CompletionOutboxRow | undefined;
    try {
      row = run();
    } catch (error) {
      throw new Error(`${prefix}: ${messageOf(error)}`);
    }
    return row === undefined ? null : rowToDelivery(row);
  }
}

/**
 * 查重：workspace 库 message 表是否已存在该 run_id 的 Result 消息。
 * 完成闭包把 envelope 原文写入 content，`run_id` 经 json_extract 可比。
 */
export function completionMessageExists(
  workspaceDb: SqlExecutor,
  workspaceId: string,
  runId: string,
): boolean {
  try {
    return outboxSql.completionMessageExists(workspaceDb, workspaceId, runId);
  } catch (error) {
    throw new Error(`failed to check completion message existence: ${messageOf(error)}`);
  }
}
