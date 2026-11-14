import type { ChatSessionService } from '../../chat/api.ts';
import { sessionSideEffectSummary } from '../../agent-skills/portable.ts';
import type { PipelineContext } from './pipeline-context.ts';
import {
  collectBatchManifests, collectTodoBatch, finalizeTask, finalizationWireReport,
  injectFinalizationIntoBlocks, parseDeclaredArtifacts,
  type ArtifactLocator, type DeclaredArtifact, type FinalizationReport, type SideEffectEvidence,
} from './finalizer.ts';

export interface CompletionFinalizerLog {
  warn(message: string): void;
  info(message: string): void;
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function tryFinalizeTaskCompletion(ctx: PipelineContext, sessions: ChatSessionService,
  locator: ArtifactLocator | null, log: CompletionFinalizerLog): FinalizationReport | null {
  const index = ctx.toolResults.findLastIndex(result => result.output !== null
    && typeof result.output === 'object' && !Array.isArray(result.output)
    && (result.output as Record<string, unknown>).task_completed === true);
  if (index < 0) return null;
  const completion = ctx.toolResults[index]!;
  let declared: DeclaredArtifact[];
  try {
    declared = parseDeclaredArtifacts(completion.input);
  } catch (error) {
    log.warn(`[Finalizer] failed to re-parse declared artifacts: ${errorText(error)}`);
    declared = [];
  }
  const batchManifests = collectBatchManifests(ctx.toolResults);
  const todoBatch = collectTodoBatch(ctx.toolResults);
  let sideEffects: SideEffectEvidence;
  try {
    const summary = sessionSideEffectSummary(sessions.database.getConnSafe(), ctx.sessionId);
    sideEffects = { ok: true, summary: {
      totalOperations: summary.totalOperations,
      pending: summary.pending.map(op => ({ operationId: op.operationId, state: op.state,
        providerId: op.providerId, action: op.action })),
    } };
  } catch (error) {
    // Rust returns Err evidence here; the checker produces OutcomeUnknown.
    sideEffects = { ok: false, error: errorText(error) };
  }
  const report = finalizeTask({ sessionId: ctx.sessionId, declaredArtifacts: declared,
    artifactsRequired: false, locator, batchManifests, todoBatch, sideEffects });
  const block = injectFinalizationIntoBlocks(ctx.toolResults, ctx.interleavedBlocks,
    index, completion.blockId ?? null, finalizationWireReport(report));
  if (block !== null) {
    ctx.dirtyInterleavedBlockIds.add(block.id);
    try {
      sessions.updateBlock(block);
    } catch (error) {
      log.warn(`[Finalizer] failed to persist finalization to block ${block.id} `
        + `(save_results will retry): ${errorText(error)}`);
    }
  }
  return report;
}

export function finalizeTaskCompletion(ctx: PipelineContext, sessions: ChatSessionService,
  locator: ArtifactLocator | null, log: CompletionFinalizerLog): void {
  try {
    const report = tryFinalizeTaskCompletion(ctx, sessions, locator, log);
    if (report !== null) {
      const verdict = report.verdict.split('_').map(word => word[0]!.toUpperCase() + word.slice(1)).join('');
      log.info(`[Finalizer] G07 task finalization: verdict=${verdict}, `
        + `exceptions=${report.exceptions.length}, session=${ctx.sessionId}`);
    }
  } catch (error) {
    log.warn(`[Finalizer] G07 finalizer failed, degraded to legacy behavior: ${errorText(error)}`);
  }
}
