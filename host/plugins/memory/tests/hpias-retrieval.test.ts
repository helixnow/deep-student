import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateHpiasSynthesis, runHpiasRetrieval, type HpiasRetrievalDeps } from '../src/hpias-retrieval.ts';
import { buildSynthesisMarkdown, resolveResearchQueries } from '../src/hpias-research.ts';
import type { JsonRecord } from '../src/hpias-payloads.ts';
import { retrievalResponse } from './hpias-retrieval-fixture.ts';

afterEach(() => vi.useRealTimers());
const evidence = retrievalResponse([{ title: 'Paper', text: 'Evidence', sourceId: 'paper-1' }]).result.hits;
const perQuery = [['query', evidence]] as const;
function fixture() {
  const events: JsonRecord[] = [];
  const controller = new AbortController();
  const call = vi.fn<HpiasRetrievalDeps['llm']['callWithConfigIdRawPrompt']>(async () => ({
    assistant_message: '\u0085## 综合结论\nReport\u0085', raw_response: '', chain_of_thought_details: null, cancelled: false,
  }));
  const search = vi.fn<HpiasRetrievalDeps['retrieval']['search']>(async () => retrievalResponse([]));
  const deps: HpiasRetrievalDeps = {
    retrieval: { search }, llm: { callWithConfigIdRawPrompt: call },
    emit: event => { events.push(event); }, warn: vi.fn(), delay: vi.fn(async () => {}), signal: controller.signal,
  };
  return { deps, events, call, search, controller };
}
const request = { sessionId: 'research', question: 'Topic', intent: { blocks: [{ type: 'research-plan',
  props: { steps: [{ label: 'query A' }, { label: 'query B' }] } }] } };

describe('HPIAS real retrieval pipeline', () => {
  it('aggregates per-query results with Rust counts, top-three citations and two-step summaries', async () => {
    const f = fixture();
    const hits = [{ title: 'A', text: 'Evidence A', sourceId: 'src' },
      { title: 'B', text: 'Evidence B' }, { title: 'C', text: 'Evidence C', sourceId: '' },
      { title: 'D', text: 'Evidence D', sourceId: 'fourth' }];
    f.search.mockResolvedValue(retrievalResponse(hits));
    await runHpiasRetrieval(request, f.deps);
    expect(f.search.mock.calls.map(([r]) => r.queryText)).toEqual(['query A', 'query B']);
    expect(f.search.mock.calls.every(([r]) => r.topK === 8 && r.queryModality === 'text' && r.resourceIds === null)).toBe(true);
    expect(f.events.filter(e => e.type === 'subagent_completed')).toEqual([1, 2].map(sub_id => ({
      type: 'subagent_completed', session_id: 'research', round: 1, sub_id, steps: 2,
      summary_md: 'A：Evidence A…', citations: [['src', 1], ['hit-2', 1], ['', 1]],
    })));
    expect(f.events.find(e => e.type === 'retrieval_completed')?.fetched).toBe(8);
    expect(f.events.find(e => e.type === 'selection_completed')).toMatchObject({ selected: 6, citations: { items: [] } });
    expect(f.call).toHaveBeenCalledOnce();
    expect(f.call.mock.calls[0]?.slice(0, 2)).toEqual(['_hpias_synthesis_', expect.stringContaining('## 查询：query B')]);
    expect(f.events.find(e => e.type === 'synthesis_updated')?.synthesis).toBe('## 综合结论\nReport');
    expect(f.events.at(-2)).toMatchObject({ type: 'subagents_done', metrics: { completed: 2 }, sub_reports: [] });
    expect(f.events.at(-1)?.type).toBe('session_completed');
    expect(f.deps.delay).toHaveBeenCalledTimes(3);
    expect(f.deps.delay).toHaveBeenCalledWith(120);
  });

  it('logs a search error, continues later queries and synthesizes only retrieved evidence', async () => {
    const f = fixture();
    f.search.mockRejectedValueOnce(new Error('route offline')).mockResolvedValueOnce(retrievalResponse([{ text: 'second evidence' }]));
    await runHpiasRetrieval(request, f.deps);
    expect(f.deps.warn).toHaveBeenCalledWith('[HpiasRetrieval] search failed for query "query A": route offline');
    expect(f.events.filter(e => e.type === 'subagent_completed')[0]).toMatchObject({ summary_md: '未检索到相关内容。', citations: [] });
    expect(f.events.find(e => e.type === 'retrieval_completed')?.fetched).toBe(1);
    expect(f.call.mock.calls[0]?.[1]).toContain('（无检索结果）');
    expect(f.call.mock.calls[0]?.[1]).toContain('second evidence');
    expect(f.events.at(-1)?.type).toBe('session_completed');
  });

  it('empty searches produce an honest deterministic report without calling the model', async () => {
    const f = fixture();
    await runHpiasRetrieval(request, f.deps);
    expect(f.call).not.toHaveBeenCalled();
    expect(f.events.find(e => e.type === 'synthesis_updated')?.synthesis)
      .toBe(buildSynthesisMarkdown('Topic', [['query A', []], ['query B', []]]));
    expect(f.events.find(e => e.type === 'selection_completed')?.selected).toBe(0);
  });

  it('stops after disposal during retrieval, without synthesizing or emitting late completion', async () => {
    const f = fixture();
    f.search.mockImplementation(async () => { f.controller.abort(); return retrievalResponse([]); });
    await runHpiasRetrieval(request, f.deps);
    expect(f.search).toHaveBeenCalledOnce();
    expect(f.call).not.toHaveBeenCalled();
    expect(f.events.at(-1)?.type).toBe('subagent_started');
  });

  it('question fallback uses Rust whitespace and the default query', () => {
    expect(resolveResearchQueries('\u0085 Topic \u0085', {})).toEqual(['Topic']);
    expect(resolveResearchQueries('\u0085', {})).toEqual(['research query']);
    expect(resolveResearchQueries('\uFEFF', {})).toEqual(['\uFEFF']);
  });
});

describe('HPIAS synthesis', () => {
  it.each(['error', 'empty'] as const)('%s output logs and uses evidence fallback', async mode => {
    const f = fixture();
    if (mode === 'error') f.call.mockRejectedValue(new Error('provider down'));
    else f.call.mockResolvedValue({ assistant_message: '\u0085\n ', raw_response: '', chain_of_thought_details: null, cancelled: false });
    expect(await generateHpiasSynthesis(f.deps, 'Topic', perQuery)).toBe(buildSynthesisMarkdown('Topic', perQuery));
    expect(f.deps.warn).toHaveBeenCalledWith(mode === 'error'
      ? '[HpiasSynthesis] LLM call failed: provider down; using deterministic fallback'
      : '[HpiasSynthesis] LLM returned empty output; using deterministic fallback');
  });

  it('times out at 90 seconds, aborts the provider and does not let late output overwrite the fallback', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let resolve!: (value: Awaited<ReturnType<typeof f.call>>) => void;
    f.call.mockImplementation(() => new Promise(done => { resolve = done; }));
    let settled = false;
    const result = generateHpiasSynthesis(f.deps, 'Topic', perQuery).then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(89_999);
    expect(settled).toBe(false);
    const signal = f.call.mock.calls[0]?.[2];
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(buildSynthesisMarkdown('Topic', perQuery));
    expect(signal?.aborted).toBe(true);
    expect(f.deps.warn).toHaveBeenCalledWith('[HpiasSynthesis] LLM timeout after 90s; using deterministic fallback');
    resolve({ assistant_message: 'too late', raw_response: '', chain_of_thought_details: null, cancelled: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('disposal aborts in-flight synthesis and clears its deadline', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.call.mockImplementation(() => new Promise(() => {}));
    const result = generateHpiasSynthesis(f.deps, 'Topic', perQuery);
    await Promise.resolve();
    f.controller.abort();
    await result;
    expect(f.call.mock.calls[0]?.[2]?.aborted).toBe(true);
    expect(f.deps.warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
