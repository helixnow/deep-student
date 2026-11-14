/**
 * Insight consolidation worker — TS mirror of `dstu-research/src/insight/jobs.rs`.
 *
 * The queue itself lives in `repository/insight-jobs.ts`; this worker executes
 * one due batch and turns consolidation decisions into a dedicated
 * "灵感演化" todo list. SRS projection writes into the `mistakes` database via
 * `repository/insight-projection.ts`, while notes/resources never use raw SQL.
 */
import { nanoid } from 'nanoid';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { TodoRepository } from '../../vfs-repos/api.ts';
import {
  completeWithConn, claimDueWithConn, failWithConn, recoverStaleLeasesWithConn,
} from '../repository/insight-jobs.ts';
import {
  getInsightCard, listInsightRelations, recallFts, type InsightCard,
} from '../repository/insight-cards.ts';
import { projectInsightCard, type InsightProjectionOwner } from '../repository/insight-projection.ts';

export type InsightTodoRepository = Pick<TodoRepository,
  'createTodoList' | 'listTodoLists' | 'createTodoItem' | 'listAllPendingItems'>;

export interface InsightWorkerOptions {
  readonly vfs: SqlExecutor;
  readonly mistakes: SqlExecutor;
  readonly todos: InsightTodoRepository;
  readonly warn: (message: string) => void;
  readonly projectionOwner: () => InsightProjectionOwner;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

function parsePayload(payloadJson: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch (error) {
    throw new Error(`Validation error: 任务 payload 非法: ${errorText(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Validation error: 任务 payload 非法: expected object');
  }
  return parsed as Record<string, unknown>;
}

function insightIdOf(payload: Record<string, unknown>, jobType: string): string {
  const insightId = payload['insight_id'];
  if (typeof insightId !== 'string') {
    throw new Error(`Validation error: ${jobType} 缺少 insight_id`);
  }
  return insightId;
}

export class InsightJobWorker {
  private readonly vfs: SqlExecutor;
  private readonly mistakes: SqlExecutor;
  private readonly todos: InsightTodoRepository;
  private readonly warn: (message: string) => void;
  private readonly projectionOwner: () => InsightProjectionOwner;
  private readonly workerId = `worker_${nanoid(6)}`;

  constructor(options: InsightWorkerOptions) {
    this.vfs = options.vfs;
    this.mistakes = options.mistakes;
    this.todos = options.todos;
    this.warn = options.warn;
    this.projectionOwner = options.projectionOwner;
  }

  /** Process one due batch. `shouldContinue` is checked between jobs. */
  runOnce(batchSize: number, shouldContinue: () => boolean = () => true): number {
    recoverStaleLeasesWithConn(this.vfs);
    const jobs = claimDueWithConn(this.vfs, this.workerId, Math.max(0, Math.floor(batchSize)));
    let done = 0;
    for (const [jobId, jobType, payloadJson] of jobs) {
      if (!shouldContinue()) break;
      try {
        this.executeJob(jobType, payloadJson);
        completeWithConn(this.vfs, jobId);
        done += 1;
      } catch (error) {
        this.warn(`[InsightJobs] job ${jobId} (${jobType}) failed: ${errorText(error)}`);
        failWithConn(this.vfs, jobId, errorText(error));
      }
    }
    return done;
  }

  private executeJob(jobType: string, payloadJson: string): void {
    switch (jobType) {
      case 'srs_projection':
        this.executeSrsProjection(payloadJson);
        return;
      case 'merge_proposal':
        this.executeMergeProposal(payloadJson);
        return;
      case 'principle_synthesis':
        this.executePrincipleSynthesis(payloadJson);
        return;
      case 'principle_review':
        this.executePrincipleReview(payloadJson);
        return;
      // The v1 insight schema has no tag columns; tag canonicalization stays an
      // idempotent no-op so older queued rows still drain.
      case 'tag_canonicalize':
        return;
      default:
        throw new Error(`Validation error: 未知任务类型: ${jobType}`);
    }
  }

  // ------------------------------------------------------------ todo channel

  /** Dedicated "灵感演化" list, get-or-create by title. */
  private evolutionListId(): string {
    const existing = this.todos.listTodoLists(this.vfs).find(list => list.title === '灵感演化');
    if (existing !== undefined) return existing.id;
    try {
      return this.todos.createTodoList(this.vfs, {
        title: '灵感演化',
        description: '灵感卡的合并/原则化决策任务（由巩固 worker 生成）',
        icon: 'lightbulb',
        color: null,
        isDefault: false,
      }).id;
    } catch (error) {
      throw new Error(`Database error: 创建灵感演化列表失败: ${errorText(error)}`);
    }
  }

  /** Decision todos are deduped by a marker embedded at the end of the body. */
  private createDecisionTodo(title: string, body: string, marker: string,
    attachmentResourceIds: readonly string[]): void {
    const duplicate = this.todos.listAllPendingItems(this.vfs).some(item =>
      item.status === 'pending' && (item.description ?? '').includes(marker));
    if (duplicate) return;
    const listId = this.evolutionListId();
    try {
      this.todos.createTodoItem(this.vfs, {
        todoListId: listId,
        title,
        description: `${body}\n\n<!-- ${marker} -->`,
        priority: 'low',
        tags: ['_insight'],
        attachments: attachmentResourceIds.length === 0 ? null : [...attachmentResourceIds],
      });
    } catch (error) {
      throw new Error(`Database error: 创建决策待办失败: ${errorText(error)}`);
    }
  }

  private static cardResourceId(card: InsightCard): string | null {
    return card.currentRevision?.resourceId ?? null;
  }

  // ---------------------------------------------------------- merge proposal

  private executeMergeProposal(payloadJson: string): void {
    const payload = parsePayload(payloadJson);
    const insightId = insightIdOf(payload, 'merge_proposal');

    const card = getInsightCard(this.vfs, insightId);
    if (card === null) return; // Source card was deleted; nothing to propose.
    if (card.status !== 'active') return;

    const candidates = recallFts(this.vfs, card.title, 5);
    for (const candidate of candidates) {
      const other = candidate.card;
      if (other.id === card.id || candidate.confidence < 0.5) continue;
      const related = listInsightRelations(this.vfs, card.id).some(relation =>
        relation.status === 'active'
        && ((relation.fromId === card.id && relation.toId === other.id)
          || (relation.fromId === other.id && relation.toId === card.id)));
      if (related) continue;

      const [a, b] = card.id < other.id ? [card, other] : [other, card];
      const marker = `insight-merge:${a.id}:${b.id}`;
      const body = `两张灵感卡高度相似（置信 ${candidate.confidence.toFixed(2)}），是否合并？\n\n`
        + `## A. ${a.title}\n- 情境：${a.currentRevision?.situation ?? ''}\n`
        + `- 规则：${a.currentRevision?.rule ?? ''}\n\n`
        + `## B. ${b.title}\n- 情境：${b.currentRevision?.situation ?? ''}\n`
        + `- 规则：${b.currentRevision?.rule ?? ''}\n\n`
        + '合并不会自动发生；若确认重复，请打开其中一张纠正/删除，'
        + '另一张可用 supersede 关系指向保留方（差异会保留在关系边上）。';
      const attachments = [InsightJobWorker.cardResourceId(a),
        InsightJobWorker.cardResourceId(b)]
        .filter((resourceId): resourceId is string => resourceId !== null);
      this.createDecisionTodo(`合并灵感卡？「${a.title}」↔「${b.title}」`, body, marker,
        attachments);
    }
  }

  // ------------------------------------------------------ principle synthesis

  private sameMethodCluster(insightId: string): string[] {
    const cluster = new Set<string>([insightId]);
    for (const relation of listInsightRelations(this.vfs, insightId)) {
      if (relation.relationType !== 'same_method' || relation.status !== 'active') continue;
      cluster.add(relation.fromId === insightId ? relation.toId : relation.fromId);
    }
    return [...cluster].sort();
  }

  private hasCounterexample(cluster: readonly string[]): boolean {
    for (const id of cluster) {
      if (listInsightRelations(this.vfs, id).some(relation =>
        relation.relationType === 'counterexample' && relation.status === 'active')) {
        return true;
      }
    }
    return false;
  }

  private executePrincipleSynthesis(payloadJson: string): void {
    const payload = parsePayload(payloadJson);
    const insightId = insightIdOf(payload, 'principle_synthesis');

    const cluster = this.sameMethodCluster(insightId);
    const cases: InsightCard[] = [];
    for (const id of cluster) {
      const card = getInsightCard(this.vfs, id);
      if (card !== null && card.status === 'active') cases.push(card);
    }
    if (cases.length < 2) return;
    if (!this.hasCounterexample(cluster)) return;

    const clusterMarker = cluster.join('+');
    const marker = `insight-principle:${clusterMarker}`;
    const existing = this.todos.listAllPendingItems(this.vfs).some(item =>
      item.status === 'pending' && (item.description ?? '').includes(marker));
    if (existing) return;

    const conditions = cases
      .map(card => card.currentRevision?.validityConditions.trim() ?? '')
      .filter(condition => condition !== '');
    const caseTitles = cases.map(card => `- ${card.title}`).join('\n');
    const body = `以下 ${cases.length} 张灵感卡共享同一方法（same_method 边），且已有反例约束，`
      + '可以上升为一张「原则卡」：\n\n'
      + `${caseTitles}\n\n`
      + '建议的原则表述（条件化）：\n'
      + `> 当 ${conditions.length === 0
        ? '（各案例未填写成立条件，建议先补齐）' : conditions.join('；且 ')} 时，优先考虑该方法簇。\n\n`
      + '确认方式：在灵感合集中新建一张原则卡，并用 abstract_of 关系把上述案例挂上去。';
    const attachments = cases
      .map(InsightJobWorker.cardResourceId)
      .filter((resourceId): resourceId is string => resourceId !== null);
    this.createDecisionTodo(`原则化提案：${cases.length} 张同方法灵感卡`, body, marker,
      attachments);
  }

  // --------------------------------------------------------- principle review

  private executePrincipleReview(payloadJson: string): void {
    const payload = parsePayload(payloadJson);
    const insightId = insightIdOf(payload, 'principle_review');
    const rawDerived = payload['derived_principles'];
    const derived = Array.isArray(rawDerived)
      && rawDerived.every((id): id is string => typeof id === 'string')
      ? rawDerived : [];

    const sourceTitle = getInsightCard(this.vfs, insightId)?.title ?? insightId;
    for (const principleId of derived) {
      const principleTitle = getInsightCard(this.vfs, principleId)?.title ?? principleId;
      this.createDecisionTodo(
        `复审原则卡「${principleTitle}」`,
        `案例卡「${sourceTitle}」刚被纠正，以其为证据派生的原则卡「${principleTitle}」可能不再成立，请复审。`,
        `insight-review:${insightId}:${principleId}`,
        [],
      );
    }
  }

  // ------------------------------------------------------------ SRS projection

  private executeSrsProjection(payloadJson: string): void {
    const payload = parsePayload(payloadJson);
    const insightId = insightIdOf(payload, 'srs_projection');
    projectInsightCard(this.mistakes, getInsightCard(this.vfs, insightId), insightId,
      this.projectionOwner);
  }
}
