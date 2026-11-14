/**
 * `InsightRecallExecutor` — Rust `src-tauri/src/chat_v2/tools/insight_recall_executor.rs`.
 *
 * Paradigm A: emits its own `insight_recall` start/end/error (no generic
 * `tool_call` events, no `save_tool_block`). Every ledger write goes through the
 * deterministic-id `recordInsightEventIdempotent`; counters move only when the
 * event row was actually inserted, so retries/variants/replays stay idempotent.
 */
import type { ExecutionContext, ToolCall, ToolConcurrency, ToolExecutor, ToolResultInfo, ToolSensitivity } from '../../chat/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import {
  calibratePolicyFromLedger, decideEscalation, decidePassive, disclosureRank, filterContent, loadPolicy,
  type DisclosureLevel, type DisclosurePolicy, type SilenceReason,
} from './disclosure.ts';
import { recallInsights, type InsightRecallModel } from './insight-recall.ts';
import type { VfsService } from '../../vfs/api.ts';
import { CitationLedger, type NumberingLedger } from './citation-ledger.ts';
import { recordInsightEventIdempotent } from '../repository/insight.ts';
import {
  bumpInsightStat, getInsightCard, latestInsightHelpLevel, touchInsightLastRecalled,
} from '../repository/insight-cards.ts';
import { argsObject, toolErrorText, type ResearchToolLog } from './research-tool-runner.ts';
import { stripToolNamespace } from './paper-save.ts';

type NumberSources = VfsService['buildNumberedSources'];
type SourceInfo = Parameters<NumberSources>[0][number];

export const INSIGHT_RECALL_TOOL = 'insight_recall';

export interface InsightRecallDeps {
  /** Rust `ctx.vfs_db`; `null` ⇔ "VFS database not available". */
  vfsDb(): SqlExecutor | null;
  /** Rust `ctx.main_db` (settings table read by `disclosure::load_policy`). */
  mainDb(): SqlExecutor | null;
  /** Rust `ctx.llm_manager`; `null` degrades recall to pure FTS. */
  llm(): InsightRecallModel | null;
  /** `ctx.get('vfs').buildNumberedSources` (Rust `build_numbered_sources`); `null` ⇔ no vfs service is mounted. */
  numberSources(): NumberSources | null;
  /** Rust `citation_ledger_for_reply`; `null` falls back to a call-local ledger. */
  ledgerForReply(sessionId: string, messageId: string, variantId: string | null): NumberingLedger | null;
  log: ResearchToolLog;
}

const SILENCE_EVENT: Record<SilenceReason, string> = {
  no_match: 'silence_no_match',
  low_confidence: 'silence_low_confidence',
  budget: 'silence_budget',
  user_disabled: 'silence_user_disabled',
};

/** Rust `format!("{:?}", reason)` for the escalation silence payload. */
const SILENCE_DEBUG: Record<SilenceReason, string> = {
  no_match: 'NoMatch', low_confidence: 'LowConfidence', budget: 'Budget', user_disabled: 'UserDisabled',
};

const ESCALATION_EVENT: Record<DisclosureLevel, string> = {
  existence: 'shown_existence',
  recall_prompt: 'recall_attempt',
  hint: 'shown_hint',
  full: 'shown_full',
  direct_answer: 'direct_answer',
  hidden: 'shown_existence',
};

/** Rust `DisclosureLevel::parse` (unknown → hidden). */
export function parseDisclosureLevel(value: string): DisclosureLevel {
  return (['existence', 'recall_prompt', 'hint', 'full', 'direct_answer'] as const)
    .find(level => level === value) ?? 'hidden';
}

function exposesMethod(level: DisclosureLevel): boolean {
  return level === 'hint' || level === 'full' || level === 'direct_answer';
}

/** `SourceInfo.score: Option<f32>`: serde_json prints the shortest f32 round-trip digits. */
function f32Json(value: number): number {
  const single = Math.fround(value);
  if (!Number.isFinite(single)) return single;
  for (let digits = 1; digits <= 9; digits += 1) {
    const candidate = Number(single.toPrecision(digits));
    if (Math.fround(candidate) === single) return candidate;
  }
  return single;
}

function asStr(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export class InsightRecallExecutor implements ToolExecutor {
  private readonly deps: InsightRecallDeps;

  constructor(deps: InsightRecallDeps) {
    this.deps = deps;
  }

  name(): string { return 'InsightRecallExecutor'; }
  canHandle(toolName: string): boolean { return stripToolNamespace(toolName) === INSIGHT_RECALL_TOOL; }
  /** Trait defaults: Low sensitivity and `Serial` concurrency (insight_recall_executor.rs overrides neither). */
  sensitivityLevel(): ToolSensitivity { return 'low'; }
  concurrencyClass(): ToolConcurrency { return 'serial'; }

  async execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResultInfo> {
    const started = performance.now();
    const args = argsObject(call);
    const query = asStr(args['query']);
    // `get(snake).or_else(|| get(camel))`: a present snake key (even JSON null) shadows the camel one.
    const pick = (snake: string, camel: string): unknown => Object.hasOwn(args, snake) ? args[snake] : args[camel];
    const insightId = asStr(pick('insight_id', 'insightId'));
    const requestedRaw = asStr(pick('requested_level', 'requestedLevel'));
    const requested = requestedRaw === null ? null : parseDisclosureLevel(requestedRaw);

    ctx.emitter.emitStart('insight_recall', ctx.message_id, ctx.block_id,
      { query, insightId, source: call.name }, null);

    let output: Record<string, unknown> | null = null;
    let failure: string | null = null;
    try {
      if (insightId !== null) output = this.escalate(insightId, requested ?? 'recall_prompt', ctx);
      else if (query !== null) output = await this.recall(query, ctx);
      else failure = 'insight_recall 需要 query 或 insight_id 参数';
    } catch (error) {
      failure = toolErrorText(error);
    }
    const durationMs = Math.floor(performance.now() - started);
    const base = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name, input: call.arguments, durationMs };
    if (failure !== null) {
      ctx.emitter.emitError('insight_recall', ctx.block_id, failure, null);
      return { ...base, output: null, success: false, error: failure };
    }
    ctx.emitter.emitEnd('insight_recall', ctx.block_id, output, null);
    return { ...base, output, success: true };
  }

  private policy(vfs: SqlExecutor): DisclosurePolicy {
    return calibratePolicyFromLedger(vfs, loadPolicy(this.deps.mainDb()));
  }

  private requireVfs(): SqlExecutor {
    const vfs = this.deps.vfsDb();
    if (vfs === null) throw new Error('VFS database not available');
    return vfs;
  }

  /** Resolved before any ledger write, so a missing vfs service never leaves events behind a failed call. */
  private requireNumbering(): NumberSources {
    const numberSources = this.deps.numberSources();
    if (numberSources === null) throw new Error('vfs service is not available');
    return numberSources;
  }

  private number(numberSources: NumberSources, sources: readonly SourceInfo[], ctx: ExecutionContext): Record<string, unknown>[] {
    const ledger = this.deps.ledgerForReply(ctx.session_id, ctx.message_id, ctx.variant_id) ?? new CitationLedger();
    return numberSources(sources, ledger);
  }

  private async recall(query: string, ctx: ExecutionContext): Promise<Record<string, unknown>> {
    const vfs = this.requireVfs();
    const numberSources = this.requireNumbering();
    const policy = this.policy(vfs);
    const candidates = await recallInsights(vfs, query, this.deps.llm(), policy.max_per_turn * 2,
      message => this.deps.log.warn(message));
    const outcomes = decidePassive(policy, candidates);

    if (candidates.length === 0) {
      recordInsightEventIdempotent(vfs, ctx.session_id, ctx.message_id, null, 'silence_no_match', 'hidden',
        JSON.stringify({ query }));
      return { sources: [], count: 0, silence: 'no_match' };
    }

    const sources: SourceInfo[] = [];
    candidates.forEach((candidate, index) => {
      const outcome = outcomes[index]!;
      if (outcome.kind === 'disclose') {
        const revision = candidate.card.currentRevision;
        const [title, situation, rule] = filterContent(outcome.level, candidate.card.title,
          revision?.situation ?? '', revision?.rule ?? '');
        const inserted = recordInsightEventIdempotent(vfs, ctx.session_id, ctx.message_id, candidate.card.id,
          'shown_existence', outcome.level);
        if (inserted) this.bestEffort(() => bumpInsightStat(vfs, candidate.card.id, 'shown_count'), 'shown_count');
        sources.push({
          title: `[灵感] ${title}`,
          url: null,
          snippet: situation,
          score: f32Json(candidate.confidence),
          metadata: {
            sourceType: 'insight',
            insightId: candidate.card.id,
            disclosureLevel: outcome.level,
            matchedVia: candidate.matchedVia,
            rule,
            verificationState: candidate.card.verificationState,
          },
        });
      } else {
        recordInsightEventIdempotent(vfs, ctx.session_id, ctx.message_id, candidate.card.id,
          SILENCE_EVENT[outcome.reason], 'hidden', JSON.stringify({ confidence: candidate.confidence }));
      }
    });

    const numbered = this.number(numberSources, sources, ctx);
    return { sources: numbered, count: numbered.length };
  }

  private escalate(insightId: string, requested: DisclosureLevel, ctx: ExecutionContext): Record<string, unknown> {
    const vfs = this.requireVfs();
    const numberSources = this.requireNumbering();
    const policy = this.policy(vfs);
    const card = getInsightCard(vfs, insightId);
    if (card === null) throw new Error(`灵感卡不存在: ${insightId}`);

    let currentRaw: string | null = null;
    try { currentRaw = latestInsightHelpLevel(vfs, insightId, ctx.session_id); }
    catch (error) { this.deps.log.debug(`[InsightRecall] help_level lookup failed: ${toolErrorText(error)}`); }
    const current = currentRaw === null ? 'hidden' : parseDisclosureLevel(currentRaw);

    const outcome = decideEscalation(policy, current, requested);
    if (outcome.kind === 'silence') {
      recordInsightEventIdempotent(vfs, ctx.session_id, ctx.message_id, insightId,
        SILENCE_EVENT[outcome.reason], 'hidden');
      return { sources: [], count: 0, silence: SILENCE_DEBUG[outcome.reason] };
    }

    const level = outcome.level;
    const revision = card.currentRevision;
    const [title, situation, rule] = filterContent(level, card.title, revision?.situation ?? '', revision?.rule ?? '');
    const inserted = recordInsightEventIdempotent(vfs, ctx.session_id, ctx.message_id, insightId,
      ESCALATION_EVENT[level], level);
    if (inserted && disclosureRank(level) >= disclosureRank('hint')) {
      this.bestEffort(() => bumpInsightStat(vfs, insightId, 'recall_count'), 'recall_count');
      this.bestEffort(() => touchInsightLastRecalled(vfs, insightId), 'last_recalled_at');
    }
    const method = exposesMethod(level);
    const numbered = this.number(numberSources, [{
      title: `[灵感] ${title}`,
      url: null,
      snippet: situation,
      score: null,
      metadata: {
        sourceType: 'insight',
        insightId,
        disclosureLevel: level,
        rule,
        turningPoint: method ? revision?.turningPoint ?? null : null,
        validityConditions: method ? revision?.validityConditions ?? null : null,
      },
    }], ctx);
    return { sources: numbered, count: 1, escalatedTo: level };
  }

  /** Rust `let _ = repo::bump_stat(..)`: counter failures never fail the recall. */
  private bestEffort(write: () => void, label: string): void {
    try { write(); }
    catch (error) { this.deps.log.debug(`[InsightRecall] ${label} update ignored: ${toolErrorText(error)}`); }
  }
}
