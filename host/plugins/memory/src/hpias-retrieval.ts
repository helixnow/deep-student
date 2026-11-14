/** Rust hpias/{retrieval_backend,synthesis}.rs: real VFS search and config-id synthesis. */
import type { LlmRawPrompt } from '../../llm/api.ts';
import type { RetrievalService } from '../../vfs-index/api.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import { errorText } from './memory-utils.ts';
import {
  buildPlanGeneratedPayload, buildRetrievalCompletedPayload, buildRoundStartedPayload,
  buildSelectionCompletedPayload, buildSessionCompletedPayload, buildSubagentCompletedPayload,
  buildSubagentStartedPayload, buildSubagentsDonePayload, buildSynthesisUpdatedPayload,
  type JsonRecord,
} from './hpias-payloads.ts';
import {
  buildSynthesisLlmPrompt, buildSynthesisMarkdown, resolveResearchQueries,
  summarizeHitsForSubagent, type HpiasFusedHit, type HpiasResearchSessionRequest,
} from './hpias-research.ts';

export interface HpiasRetrievalDeps {
  retrieval: Pick<RetrievalService, 'search'>;
  llm: Pick<LlmRawPrompt, 'callWithConfigIdRawPrompt'>;
  emit(payload: JsonRecord): void;
  warn(message: string): void;
  delay(milliseconds: number): Promise<void>;
  signal: AbortSignal;
}

const SYNTHESIS_TIMEOUT_MS = 90_000;
const TIMED_OUT = Symbol('hpias synthesis timeout');
const STOPPED = Symbol('hpias disposed');

/** Empty evidence avoids a model call; errors, empty output and timeout use Rust's deterministic report. */
export async function generateHpiasSynthesis(deps: Pick<HpiasRetrievalDeps, 'llm' | 'warn' | 'signal'>,
  question: string | null, perQuery: readonly (readonly [string, readonly HpiasFusedHit[]])[]): Promise<string> {
  const fallback = buildSynthesisMarkdown(question, perQuery);
  if (deps.signal.aborted || perQuery.every(([, hits]) => hits.length === 0)) return fallback;
  const controller = new AbortController();
  let stop!: () => void;
  const stopped = new Promise<typeof STOPPED>(resolve => { stop = () => {
    resolve(STOPPED);
    controller.abort(deps.signal.reason);
  }; });
  deps.signal.addEventListener('abort', stop, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>(resolve => {
    timer = setTimeout(() => { resolve(TIMED_OUT); controller.abort(); }, SYNTHESIS_TIMEOUT_MS);
  });
  try {
    const call = Promise.resolve().then(() => deps.llm.callWithConfigIdRawPrompt(
      '_hpias_synthesis_', buildSynthesisLlmPrompt(question, perQuery), controller.signal));
    const response = await Promise.race([call, deadline, stopped]);
    if (response === STOPPED) return fallback;
    if (response === TIMED_OUT) {
      deps.warn('[HpiasSynthesis] LLM timeout after 90s; using deterministic fallback');
      return fallback;
    }
    const text = rustTrim(response.assistant_message);
    if (text !== '') return text;
    deps.warn('[HpiasSynthesis] LLM returned empty output; using deterministic fallback');
  } catch (error) {
    if (!deps.signal.aborted) deps.warn(`[HpiasSynthesis] LLM call failed: ${errorText(error)}; using deterministic fallback`);
  } finally {
    clearTimeout(timer);
    deps.signal.removeEventListener('abort', stop);
  }
  return fallback;
}

/** One round, sequential top-8 text searches; counts intentionally include repeated hits, as in Rust. */
export async function runHpiasRetrieval(request: HpiasResearchSessionRequest, deps: HpiasRetrievalDeps): Promise<void> {
  const round = 1;
  const session = request.sessionId;
  const queries = resolveResearchQueries(request.question, request.intent);
  // Like Rust, retrieval continues after a send failure; retain a diagnostic in Host.
  const emit = (payload: JsonRecord): void => {
    if (deps.signal.aborted) return;
    try { deps.emit(payload); }
    catch (error) { deps.warn(`[HpiasRetrieval] emit failed: ${errorText(error)}`); }
  };
  if (deps.signal.aborted) return;
  emit(buildRoundStartedPayload(session, round));
  await deps.delay(120);
  if (deps.signal.aborted) return;
  emit(buildPlanGeneratedPayload(session, round, { core: { queries } }));
  const perQuery: Array<[string, HpiasFusedHit[]]> = [];
  let fetched = 0;
  for (const [index, query] of queries.entries()) {
    if (deps.signal.aborted) return;
    const subId = index + 1;
    emit(buildSubagentStartedPayload(session, round, subId, query));
    let hits: HpiasFusedHit[] = [];
    try {
      const response = await deps.retrieval.search({
        queryText: query, queryImageBase64: null, queryImageMediaType: null,
        queryModality: 'text', topK: 8, folderIds: null, resourceIds: null, resourceTypes: null,
      });
      hits = response.result.hits;
      fetched += hits.length;
    } catch (error) {
      if (deps.signal.aborted) return;
      deps.warn(`[HpiasRetrieval] search failed for query ${JSON.stringify(query)}: ${errorText(error)}`);
    }
    if (deps.signal.aborted) return;
    emit(buildSubagentCompletedPayload(session, round, subId, 2, summarizeHitsForSubagent(hits),
      hits.slice(0, 3).map((hit, i) => [hit.hit.sourceId ?? `hit-${i + 1}`, 1])));
    perQuery.push([query, hits]);
    await deps.delay(120);
  }
  if (deps.signal.aborted) return;
  emit(buildRetrievalCompletedPayload(session, round, fetched));
  emit(buildSelectionCompletedPayload(session, round, Math.min(fetched, queries.length * 3), { items: [] }));
  const synthesis = await generateHpiasSynthesis(deps, request.question, perQuery);
  if (deps.signal.aborted) return;
  emit(buildSynthesisUpdatedPayload(session, round, synthesis));
  emit(buildSubagentsDonePayload(session, round, { completed: queries.length }, []));
  emit(buildSessionCompletedPayload(session, round));
}
