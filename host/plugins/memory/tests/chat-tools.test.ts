import { describe, expect, it } from 'vitest';
import {
  CitationLedger, academicSearchCanHandle, academicSearchSensitivity,
  papersToSources, parseArxivAtom, reconstructAbstract,
} from '../src/academic-search.ts';
import { buildNumberedSources } from '../../vfs/api.ts';
import {
  knowledgeCanHandle, knowledgeSensitivity, parseExtractionResponse,
} from '../src/knowledge.ts';
import {
  MAX_RANGE_DAYS, aggregateActivities, aggregatePomodoro, learningOverviewCanHandle,
  learningOverviewConcurrency, learningOverviewSensitivity, mergeDaily, paginate,
  parseDailyRequest, parseOverviewRequest,
  type LearningActivity, type PomodoroDailyStat,
} from '../src/learning-overview.ts';
import { rerankShortCircuit, type RerankResult } from '../src/reranker.ts';

describe('academic search executor pure layer', () => {
  it('test_can_handle academic_search', () => {
    expect(academicSearchCanHandle('builtin-arxiv_search')).toBe(true);
    expect(academicSearchCanHandle('builtin-scholar_search')).toBe(true);
    expect(academicSearchCanHandle('builtin-web_search')).toBe(false);
    expect(academicSearchCanHandle('builtin-web_fetch')).toBe(false);
    expect(academicSearchCanHandle('some_other_tool')).toBe(false);
  });

  it('test_sensitivity academic_search', () => {
    expect(academicSearchSensitivity()).toBe('low');
  });

  it('academic_sources_share_reply_citation_ledger', () => {
    const first = papersToSources([{
      id: '2401.00001',
      title: 'First paper',
      abstract: 'First abstract',
      arxivUrl: 'https://arxiv.org/abs/2401.00001',
    }], 'arxiv');
    const second = papersToSources([{
      id: 'https://openalex.org/W2',
      title: 'Second paper',
      abstract: 'Second abstract',
      doi: 'https://doi.org/10.1000/example',
    }], 'openalex');
    const ledger = new CitationLedger();
    const firstNumbered = buildNumberedSources(first, ledger);
    const secondNumbered = buildNumberedSources(second, ledger);
    expect(firstNumbered[0]!['citationTag']).toBe('[搜索-1]');
    expect(secondNumbered[0]!['citationTag']).toBe('[搜索-2]');
    expect(secondNumbered[0]!['typeIndex']).toBe(2);
  });

  it('test_parse_arxiv_atom_basic', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2401.12345v1</id>
    <title>Test Paper Title</title>
    <summary>This is a test abstract.</summary>
    <published>2024-01-15T00:00:00Z</published>
    <author><name>John Doe</name></author>
    <author><name>Jane Smith</name></author>
    <category term="cs.AI"/>
    <category term="cs.LG"/>
    <link title="pdf" href="http://arxiv.org/pdf/2401.12345v1" rel="related" type="application/pdf"/>
  </entry>
</feed>`;
    const papers = parseArxivAtom(xml);
    expect(papers).toHaveLength(1);
    const paper = papers[0]!;
    expect(paper.id).toBe('2401.12345');
    expect(paper.title).toBe('Test Paper Title');
    expect(paper.abstract).toBe('This is a test abstract.');
    expect(paper.authors).toHaveLength(2);
    expect(paper.categories).toHaveLength(2);
  });

  it('test_parse_arxiv_atom_empty', () => {
    const papers = parseArxivAtom(`<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
</feed>`);
    expect(papers).toHaveLength(0);
  });

  it('test_reconstruct_abstract', () => {
    const result = reconstructAbstract({
      Hello: [0], world: [1], this: [2], is: [3], a: [4], test: [5],
    });
    expect(result).toBe('Hello world this is a test');
  });

  it('test_reconstruct_abstract_repeated_word', () => {
    const result = reconstructAbstract({ the: [0, 2], cat: [1], dog: [3] });
    expect(result).toBe('the cat the dog');
  });
});

describe('knowledge executor pure layer', () => {
  it('test_can_handle knowledge_executor', () => {
    expect(knowledgeCanHandle('builtin-knowledge_internalize')).toBe(false);
    expect(knowledgeCanHandle('builtin-knowledge_extract')).toBe(true);
    expect(knowledgeCanHandle('builtin-memory_search')).toBe(false);
    expect(knowledgeCanHandle('builtin-rag_search')).toBe(false);
    expect(knowledgeCanHandle('note_read')).toBe(false);
  });

  it('test_strip_namespace knowledge_extract', () => {
    expect(knowledgeCanHandle('knowledge_extract')).toBe(true);
  });

  it('test_sensitivity_level knowledge_extract', () => {
    expect(knowledgeSensitivity()).toBe('low');
  });

  it('test_parse_extraction_response knowledge', () => {
    const response = `\`\`\`json
[
  {"content": "勾股定理", "category": "定理"},
  {"content": "公式法解方程", "category": "方法"}
]
\`\`\``;
    const candidates = parseExtractionResponse(response);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.content).toBe('勾股定理');
    expect(candidates[0]!.category).toBe('定理');
  });

  it('test_parse_empty_response knowledge', () => {
    expect(parseExtractionResponse('[]')).toHaveLength(0);
  });
});

describe('learning overview pure layer', () => {
  it('overview_defaults_to_seven_days_and_strict_pagination', () => {
    const today = '2026-07-14';
    const request = parseOverviewRequest({}, today);
    expect(request.startDate).toBe('2026-07-08');
    expect(request.endDate).toBe('2026-07-14');
    expect(request.page).toEqual({ page: 1, pageSize: 20 });

    let error: Record<string, unknown> | null = null;
    try {
      parseOverviewRequest({ page_size: 21 }, today);
    } catch (thrown) {
      error = JSON.parse(thrown instanceof Error ? thrown.message : String(thrown)) as Record<string, unknown>;
    }
    expect(error?.['code']).toBe('INVALID_ARGUMENT');
    expect(error?.['field']).toBe('page_size');
    expect(typeof (error?.['messageFallback'] as Record<string, unknown>)?.['en-US']).toBe('string');
  });

  it('overview_requires_exact_bounded_past_date_range', () => {
    const today = '2026-07-14';
    for (const argumentsValue of [
      { start_date: '2026-07-01' },
      { start_date: '2026-7-01', end_date: '2026-07-02' },
      { start_date: '2026-02-30', end_date: '2026-03-01' },
      { start_date: '2026-07-02', end_date: '2026-07-01' },
      { unknown: true },
    ]) {
      expect(() => parseOverviewRequest(argumentsValue, today)).toThrow();
    }
    const tooOld = '2026-04-15';
    expect(today.localeCompare(tooOld)).toBeGreaterThan(0);
    expect(() => parseOverviewRequest({ start_date: tooOld, end_date: today }, today)).toThrow();
    expect(MAX_RANGE_DAYS).toBe(90);
  });

  it('daily_parser_is_closed_and_bounded', () => {
    expect(parseDailyRequest({ days: 30, page: 2, page_size: 10 })).toEqual({
      days: 30, page: { page: 2, pageSize: 10 },
    });
    expect(() => parseDailyRequest({ days: 0 })).toThrow();
    expect(() => parseDailyRequest({ days: 91 })).toThrow();
    expect(() => parseDailyRequest({ offset: 1 })).toThrow();
  });

  it('normal_aggregation_and_pagination_preserve_full_totals', () => {
    const activities: LearningActivity[] = [{
      date: '2026-07-14', count: 3, studySeconds: 900,
      details: {
        chatSessions: 1, chatMessages: 2, notesEdited: 0, textbooksOpened: 0,
        examsCreated: 0, translationsCreated: 0, essaysCreated: 0,
        ankiCardsCreated: 0, questionsAnswered: 0,
      },
    }];
    const pomodoro: PomodoroDailyStat[] = [{
      date: '2026-07-14', completedCount: 2, focusSeconds: 3000, interruptedCount: 1,
    }];
    const totals = aggregateActivities(activities);
    expect(totals.count).toBe(3);
    expect(totals.chatMessages).toBe(2);
    expect(aggregatePomodoro(pomodoro).focusSeconds).toBe(3000);

    const daily = mergeDaily(activities, pomodoro, '2026-07-13', '2026-07-14');
    const firstPage = paginate(daily, { page: 1, pageSize: 1 });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.hasMore).toBe(true);
    expect(daily[1]!.pomodoro.focusSeconds).toBe(3000);
  });

  it('all_tools_are_low_sensitivity_read_only', () => {
    for (const name of [
      'builtin-learning_overview',
      'builtin-pomodoro_today_stats',
      'builtin-pomodoro_daily_stats',
    ]) {
      expect(learningOverviewCanHandle(name)).toBe(true);
      expect(learningOverviewSensitivity()).toBe('low');
      expect(learningOverviewConcurrency()).toBe('read_only');
    }
    expect(learningOverviewCanHandle('builtin-pomodoro_create')).toBe(false);
  });
});

describe('memory reranker', () => {
  it('test_empty_results', () => {
    const results: RerankResult[] = [];
    expect(results).toHaveLength(0);
    expect(rerankShortCircuit(results, true)).toEqual([]);
    expect(rerankShortCircuit(results, false)).toEqual([]);
  });
});
