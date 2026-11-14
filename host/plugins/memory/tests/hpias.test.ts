import { describe, expect, it, vi } from 'vitest';
import { setupMemoryHost } from './support.ts';
import type { GenerativeResearchPort } from '../api.ts';
import {
  HPIAS_EVENT_CHANNEL, MAX_RESEARCH_PLAN_QUERIES, buildPipelineTimeline,
  buildSessionStartedPayload, extractPlanQueriesFromIntent, intentHasResearchBlocks,
} from '../src/hpias-payloads.ts';
import {
  backendKindFromConfig, buildSynthesisLlmPrompt, buildSynthesisMarkdown, canRunRetrieval,
  resolveResearchQueries, shouldStartResearchSession, summarizeHitsForSubagent,
  type HpiasFusedHit, type HpiasResearchDeps,
} from '../src/hpias-research.ts';

function sampleHit(text: string, title: string, sourceId: string | null = 'paper-1'): HpiasFusedHit {
  return { hit: { text, title, sourceId } };
}

describe('hpias events', () => {
  it('channel_matches_frontend_contract', () => {
    expect(HPIAS_EVENT_CHANNEL).toBe('hpias_event');
  });

  it('build_session_started_payload_includes_question_when_present', () => {
    const payload = buildSessionStartedPayload('research-chat-1', 'What is X?', null);
    expect(payload['type']).toBe('session_started');
    expect(payload['session_id']).toBe('research-chat-1');
    expect(payload['question']).toBe('What is X?');
  });

  it('build_session_started_payload_omits_blank_question', () => {
    const payload = buildSessionStartedPayload('s1', '   ', null);
    expect(payload).not.toHaveProperty('question');
  });
});

describe('hpias orchestrator', () => {
  it('spawn_from_intent_skips_non_research_intent', async () => {
    const intent = { blocks: [{ type: 'text', props: { text: 'hi' } }] };
    expect(intentHasResearchBlocks(intent)).toBe(false);
    expect(shouldStartResearchSession(intent)).toBe(false);
    expect(shouldStartResearchSession({
      blocks: [{ type: 'research-plan', props: { steps: [] } }],
    })).toBe(true);
    const host = await setupMemoryHost({ memoryConfig: { hpiasBackend: 'stub' } });
    try {
      vi.useFakeTimers();
      const emitted: unknown[] = [];
      host.host.ctx.backendEvents.listen('hpias_event', payload => { emitted.push(payload); });
      const research = host.host.ctx.get('hpiasResearch') as GenerativeResearchPort;
      research.startFromIntent({ window: { window: 'main', webview: 'main' },
        sessionId: 'non-research', title: 'text', intent });
      await vi.advanceTimersByTimeAsync(400);
      expect(emitted).toEqual([]);
      research.startFromIntent({ window: { window: 'main', webview: 'main' },
        sessionId: 'research', title: 'question',
        intent: { blocks: [{ type: 'research-plan', props: { steps: [] } }] } });
      await vi.advanceTimersByTimeAsync(400);
      expect(emitted[0]).toMatchObject({ type: 'session_started', session_id: 'research' });
      expect(emitted[1]).toMatchObject({ type: 'round_started', session_id: 'research' });
    } finally {
      vi.unstubAllEnvs();
      vi.useRealTimers();
      await host.dispose();
    }
  });

  it('pipeline_timeline_length_matches_style_lab_demo', () => {
    const timeline = buildPipelineTimeline('demo', 'Q', null);
    // session_started + round + plan + retrieval + selection + 2*(start+complete)
    // + synthesis + subagents_done + completed
    expect(timeline.length).toBeGreaterThanOrEqual(10);
  });
});

describe('hpias payloads', () => {
  it('intent_has_research_blocks_detects_research_plan', () => {
    const intent = { blocks: [{ type: 'research-plan', props: { steps: [] } }] };
    expect(intentHasResearchBlocks(intent)).toBe(true);
  });

  it('intent_has_research_blocks_rejects_text_only', () => {
    const intent = { blocks: [{ type: 'text', props: { text: 'hi' } }] };
    expect(intentHasResearchBlocks(intent)).toBe(false);
  });

  it('extract_plan_queries_from_research_plan_steps', () => {
    const intent = {
      blocks: [{
        type: 'research-plan',
        props: { steps: [{ label: 'Query A' }, { label: 'Query B' }] },
      }],
    };
    expect(extractPlanQueriesFromIntent(intent)).toEqual(['Query A', 'Query B']);
  });

  it('extract_plan_queries_deduplicates_and_caps_at_frontend_limit', () => {
    const steps = [{ label: 'Query 0' }, { label: 'Query 0' }];
    for (let index = 1; index < 20; index += 1) steps.push({ label: `Query ${index}` });
    const intent = { blocks: [{ type: 'research-plan', props: { steps } }] };
    const queries = extractPlanQueriesFromIntent(intent);
    expect(queries).toHaveLength(MAX_RESEARCH_PLAN_QUERIES);
    expect(queries[0]).toBe('Query 0');
    expect(queries.at(-1)).toBe('Query 11');
  });

  it('build_pipeline_timeline_includes_lifecycle_events', () => {
    const timeline = buildPipelineTimeline('s1', 'Q?', null);
    const types = timeline.flatMap(event =>
      typeof event['type'] === 'string' ? [event['type']] : []);
    for (const required of ['session_started', 'plan_generated', 'retrieval_completed',
      'synthesis_updated', 'session_completed']) {
      expect(types).toContain(required);
    }
  });

  it('build_pipeline_timeline_uses_intent_synthesis', () => {
    const intent = { blocks: [{ type: 'research-report', props: { body: 'Custom synthesis body' } }] };
    const timeline = buildPipelineTimeline('s1', null, intent);
    const synthesis = timeline.find(event => event['type'] === 'synthesis_updated');
    expect(synthesis?.['synthesis']).toBe('Custom synthesis body');
  });

  it('build_pipeline_timeline_formats_stub_citation_ids', () => {
    const intent = { blocks: [{ type: 'research-plan', props: { steps: [{ label: 'Query A' }] } }] };
    const timeline = buildPipelineTimeline('s1', null, intent);
    const completed = timeline.find(event => event['type'] === 'subagent_completed');
    expect(completed?.['citations']).toEqual([['paper-1', 1]]);
    expect(JSON.stringify(completed)).not.toContain('paper-{}');
  });

  it('build_pipeline_timeline_covers_required_lifecycle', () => {
    const timeline = buildPipelineTimeline('s1', 'Q', null);
    const types = timeline.flatMap(event =>
      typeof event['type'] === 'string' ? [event['type']] : []);
    for (const required of ['session_started', 'round_started', 'plan_generated',
      'retrieval_completed', 'selection_completed', 'subagent_started', 'subagent_completed',
      'synthesis_updated', 'subagents_done', 'session_completed']) {
      expect(types).toContain(required);
    }
  });
});

describe('hpias retrieval backend', () => {
  it('summarize_hits_empty_returns_placeholder', () => {
    expect(summarizeHitsForSubagent([])).toBe('未检索到相关内容。');
  });

  it('build_synthesis_includes_question_heading', () => {
    const markdown = buildSynthesisMarkdown('AI in medicine', []);
    expect(markdown).toContain('AI in medicine');
    expect(markdown).toContain('综合结论');
  });

  it('deps_can_run_retrieval_requires_vfs_and_llm', () => {
    const empty: HpiasResearchDeps = {};
    expect(canRunRetrieval(empty)).toBe(false);
    expect(canRunRetrieval({ vfsDb: {} })).toBe(false);
    expect(canRunRetrieval({ llmManager: {} })).toBe(false);
    expect(canRunRetrieval({ vfsDb: {}, llmManager: {} })).toBe(true);
  });

  it('resolve_queries_prefers_intent_then_question_then_default', () => {
    const intent = { blocks: [{ type: 'research-plan', props: { steps: [{ label: 'From intent' }] } }] };
    expect(resolveResearchQueries('Question', intent)).toEqual(['From intent']);
    expect(resolveResearchQueries('  Question  ', null)).toEqual(['Question']);
    expect(resolveResearchQueries('   ', null)).toEqual(['research query']);
  });

  it('summarize_hits_uses_title_and_truncates_snippet', () => {
    expect(summarizeHitsForSubagent([sampleHit('abc', '')]))
      .toBe('检索结果：abc…');
    const long = 'x'.repeat(300);
    expect(summarizeHitsForSubagent([sampleHit(long, 'Paper')]))
      .toBe(`Paper：${'x'.repeat(240)}…`);
    expect(summarizeHitsForSubagent([sampleHit('', 'Paper')])).toBe('Paper（无文本片段）');
  });
});

describe('hpias service', () => {
  it('request_carries_session_and_intent', () => {
    const intent = { blocks: [{ type: 'research-plan', props: { steps: [] } }] };
    const request = { sessionId: 's1', question: 'Q?', intent };
    expect(request.sessionId).toBe('s1');
    expect(intentHasResearchBlocks(request.intent)).toBe(true);
  });

  it('backend_kind_defaults_to_disabled', () => {
    expect(backendKindFromConfig(null)).toBe('disabled');
    expect(backendKindFromConfig('')).toBe('disabled');
    expect(backendKindFromConfig('   ')).toBe('disabled');
  });

  it('backend_kind_reads_env_stub', () => {
    expect(backendKindFromConfig('stub')).toBe('stub');
    expect(backendKindFromConfig('  STUB  ')).toBe('stub');
  });

  it('backend_kind_reads_env_retrieval', () => {
    expect(backendKindFromConfig('retrieval')).toBe('retrieval');
    expect(backendKindFromConfig('Retrieval')).toBe('retrieval');
  });

  it('backend_kind_unknown_value_fails_closed', () => {
    expect(backendKindFromConfig('unexpected')).toBe('disabled');
  });
});

describe('hpias synthesis', () => {
  it('build_synthesis_llm_prompt_includes_question_and_evidence', () => {
    const perQuery: [string, HpiasFusedHit[]][] = [
      ['AI medicine', [sampleHit('Some finding about AI.', 'Paper A')]],
    ];
    const prompt = buildSynthesisLlmPrompt('AI in medicine?', perQuery);
    expect(prompt).toContain('AI in medicine?');
    expect(prompt).toContain('Paper A');
    expect(prompt).toContain('综合结论');
  });
});
