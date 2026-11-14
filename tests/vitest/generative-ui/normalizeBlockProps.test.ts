/**
 * normalizeBlockProps：LLM 常见 props 别名 → registry schema 字段的归一化回归。
 *
 * 只覆盖「无歧义别名」：目标字段缺失时填充、已有值不覆盖、无改动保持原引用。
 */
import { describe, expect, it } from 'vitest';
import { normalizeGenerativeBlocks } from '@/features/generative-ui/normalizeBlockProps';
import { MAX_GENERATIVE_UI_BLOCKS } from '@/features/generative-ui/schema';
import type { GenerativeBlockIntent } from '@/features/generative-ui/types';

function one(block: GenerativeBlockIntent): Record<string, unknown> {
  const result = normalizeGenerativeBlocks([block]);
  expect(result).toHaveLength(1);
  return result[0].props as Record<string, unknown>;
}

describe('normalizeGenerativeBlocks — stat-card', () => {
  it('maps hint / description to subtitle', () => {
    expect(one({ type: 'stat-card', props: { title: 'T', value: 1, hint: '较上周 +3' } })).toMatchObject({
      title: 'T',
      value: 1,
      subtitle: '较上周 +3',
    });
    expect(
      one({ type: 'stat-card', props: { title: 'T', value: 1, description: '描述' } }).subtitle,
    ).toBe('描述');
  });

  it('appends unit to numeric / string values without duplicating it', () => {
    expect(one({ type: 'stat-card', props: { title: 'T', value: 12, unit: '道' } }).value).toBe('12 道');
    expect(one({ type: 'stat-card', props: { title: 'T', value: '92%', unit: '%' } }).value).toBe('92%');
  });

  it('never overrides explicit subtitle', () => {
    expect(
      one({ type: 'stat-card', props: { title: 'T', value: 1, subtitle: 'keep', hint: 'drop' } }).subtitle,
    ).toBe('keep');
  });
});

describe('normalizeGenerativeBlocks — alert', () => {
  it('maps level to variant', () => {
    const cases: Array<[string, string]> = [
      ['info', 'info'],
      ['warning', 'warning'],
      ['warn', 'warning'],
      ['error', 'destructive'],
      ['danger', 'destructive'],
      ['destructive', 'destructive'],
      ['notice', 'default'],
    ];
    for (const [level, variant] of cases) {
      expect(one({ type: 'alert', props: { title: 'T', level } }).variant).toBe(variant);
    }
  });

  it('maps message / content to description', () => {
    expect(one({ type: 'alert', props: { title: 'T', message: '消息' } }).description).toBe('消息');
    expect(one({ type: 'alert', props: { title: 'T', content: '内容' } }).description).toBe('内容');
  });
});

describe('normalizeGenerativeBlocks — list', () => {
  it('converts string items and common label / description / badge aliases', () => {
    const props = one({
      type: 'list',
      props: {
        title: 'L',
        items: [
          '纯字符串',
          { text: '正文', meta: '说明', tag: '新' },
          { name: '名字', subtitle: '副标题', status: 'done' },
        ],
      },
    });
    expect(props.items).toEqual([
      { label: '纯字符串' },
      expect.objectContaining({ label: '正文', description: '说明', badge: '新' }),
      expect.objectContaining({ label: '名字', description: '副标题', badge: 'done' }),
    ]);
  });
});

describe('normalizeGenerativeBlocks — progress / text / markdown', () => {
  it('maps value/max to current/total and defaults total', () => {
    expect(one({ type: 'progress', props: { value: 30 } })).toMatchObject({ current: 30, total: 100 });
    expect(one({ type: 'progress', props: { value: 30, max: 60 } })).toMatchObject({
      current: 30,
      total: 60,
    });
    expect(one({ type: 'progress', props: { current: 1, total: 2 } })).toEqual({ current: 1, total: 2 });
  });

  it('maps text / content to body and title to heading', () => {
    expect(one({ type: 'text', props: { text: '正文', title: '标题' } })).toMatchObject({
      body: '正文',
      heading: '标题',
    });
  });

  it('maps content / text / markdown to markdown body', () => {
    expect(one({ type: 'markdown', props: { content: '# 标题' } }).body).toBe('# 标题');
    expect(one({ type: 'markdown', props: { text: '文本' } }).body).toBe('文本');
  });
});

describe('normalizeGenerativeBlocks — key-value-grid / chart', () => {
  it('maps items to rows with key aliases', () => {
    const props = one({
      type: 'key-value-grid',
      props: {
        items: [
          { label: 'K', value: 'V' },
          { name: 'N', val: 3 },
          { key: '', value: 'dropped' },
        ],
      },
    });
    expect(props.rows).toEqual([
      { key: 'K', value: 'V' },
      { key: 'N', value: '3' },
    ]);
  });

  it('maps chartType/type to kind and aligns series length with categories', () => {
    expect(one({ type: 'chart', props: { chartType: 'line', categories: ['a'], series: [{ name: 's', values: [1] }] } }).kind).toBe('line');
    const padded = one({
      type: 'chart',
      props: { type: 'bar', categories: ['a', 'b'], series: [{ name: 's', values: [1] }] },
    });
    expect((padded.series as Array<{ values: number[] }>)[0].values).toEqual([1, 0]);
    const sliced = one({
      type: 'chart',
      props: { kind: 'pie', categories: ['a'], series: [{ name: 's', values: [1, 2, 3] }] },
    });
    expect((sliced.series as Array<{ values: number[] }>)[0].values).toEqual([1]);
  });

  it('keeps an unknown chart kind untouched so schema can report it', () => {
    expect(one({ type: 'chart', props: { chartType: 'radar', categories: ['a'] } }).kind).toBeUndefined();
  });
});

describe('normalizeGenerativeBlocks — steps / table', () => {
  it('maps items to steps, label aliases and status synonyms', () => {
    expect(
      one({
        type: 'steps',
        props: {
          items: [
            { title: '设计', status: 'completed' },
            { name: '实现', status: 'in_progress' },
            { label: '验收', status: 'todo' },
          ],
        },
      }).steps,
    ).toEqual([
      { title: '设计', status: 'done', label: '设计' },
      { name: '实现', status: 'active', label: '实现' },
      { label: '验收', status: 'pending' },
    ]);
  });

  it('converts string columns and array rows into schema shapes', () => {
    const props = one({
      type: 'table',
      props: {
        columns: ['方案', '复杂度'],
        rows: [['Parameter Server', 'O(K)'], ['Ring AllReduce', 42, true]],
      },
    });
    expect(props.columns).toEqual([
      { key: 'col_0', label: '方案' },
      { key: 'col_1', label: '复杂度' },
    ]);
    expect(props.rows).toEqual([
      { col_0: 'Parameter Server', col_1: 'O(K)' },
      { col_0: 'Ring AllReduce', col_1: 42, col_2: 'true' },
    ]);
  });

  it('fills missing column labels from title / name / header', () => {
    const props = one({
      type: 'table',
      props: {
        columns: [{ key: 'a', header: '甲' }, { key: 'b', name: '乙' }],
        rows: [{ a: 1, b: 2 }],
      },
    });
    expect(props.columns).toEqual([
      { key: 'a', header: '甲', label: '甲' },
      { key: 'b', name: '乙', label: '乙' },
    ]);
  });
});

describe('normalizeGenerativeBlocks — calendar / mistake / paper / research', () => {
  it('maps review-calendar data/items/schedule to days', () => {
    const props = one({
      type: 'review-calendar',
      props: { data: [{ date: '2026-11-11', label: '今天', count: 12, completedCount: 3 }] },
    });
    expect(props.days).toEqual([
      { date: '2026-11-11', label: '今天', dueCount: 12, completedCount: 3 },
    ]);
  });

  it('maps mistake-analysis items to topic / errorRate / suggestion', () => {
    const props = one({
      type: 'mistake-analysis',
      props: {
        title: '函数与导数',
        summary: '整体偏弱',
        items: [{ question: '求导', analysis: '漏了链式法则', knowledgePoint: '链式法则' }],
      },
    });
    expect(props.topic).toBe('函数与导数');
    expect(props.errorRate).toBe(100);
    expect(props.mistakeCount).toBe(1);
    expect(String(props.suggestion)).toContain('整体偏弱');
    expect(String(props.suggestion)).toContain('【求导】');
  });

  it('maps paper-digest aliases', () => {
    const props = one({
      type: 'paper-digest',
      props: {
        title: 'Paper',
        authors: ['A', 'B'],
        keyIdea: '核心思想',
        method: '方法',
        problem: '待解决问题',
        doi: '10.1234/xyz',
      },
    });
    expect(props.authors).toBe('A, B');
    expect(props.keyFindings).toEqual(['核心思想', '方法']);
    expect(props.abstractExcerpt).toBe('待解决问题');
    expect(props.citationLabel).toBe('10.1234/xyz');
  });

  it('maps research-plan phases to steps', () => {
    const props = one({
      type: 'research-plan',
      props: {
        title: 'Plan',
        phases: [
          { name: '文献调研', duration: '2 天', goals: ['确定范围'] },
          { title: '实验', status: 'done' },
        ],
      },
    });
    expect(props.steps).toEqual([
      { label: '文献调研（2 天）：确定范围', status: 'active' },
      { label: '实验', status: 'done' },
    ]);
  });

  it('maps research-report sections / content to body', () => {
    const sections = one({
      type: 'research-report',
      props: { title: 'R', sections: [{ heading: '背景', content: '正文' }] },
    }).body;
    expect(sections).toBe('### 背景\n\n正文');
    expect(one({ type: 'research-report', props: { summary: '摘要正文' } }).body).toBe('摘要正文');
  });
});

describe('normalizeGenerativeBlocks — flashcard expansion', () => {
  it('expands cards[] into one block per card, mapping tag/deckName', () => {
    const result = normalizeGenerativeBlocks([
      {
        type: 'flashcard-preview',
        id: 'deck',
        props: {
          title: '第三章',
          cards: [
            { front: 'Q1', back: 'A1', tag: '基础' },
            { front: 'Q2', back: 'A2', tags: ['进阶'], deckName: '自定义' },
          ],
        },
      },
    ]);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      type: 'flashcard-preview',
      props: { front: 'Q1', back: 'A1', tags: ['基础'], deckName: '第三章' },
    });
    expect(result[1]).toMatchObject({
      type: 'flashcard-preview',
      props: { front: 'Q2', back: 'A2', tags: ['进阶'], deckName: '自定义' },
    });
    // 展开后不再沿用原块 id，避免重复 id
    expect(result[0].id).toBeUndefined();
    expect(result[1].id).toBeUndefined();
  });

  it('keeps a valid single flashcard untouched', () => {
    const block: GenerativeBlockIntent = {
      type: 'flashcard-preview',
      props: { front: 'Q', back: 'A', cards: [{ front: 'x', back: 'y' }] },
    };
    expect(normalizeGenerativeBlocks([block])[0]).toBe(block);
  });

  it('keeps an unexpandable block so schema errors stay diagnosable', () => {
    const block: GenerativeBlockIntent = {
      type: 'flashcard-preview',
      props: { cards: [{ front: '', back: '' }] },
    };
    expect(normalizeGenerativeBlocks([block])[0]).toBe(block);
  });

  it(`caps expanded blocks at ${MAX_GENERATIVE_UI_BLOCKS}`, () => {
    const cards = Array.from({ length: 40 }, (_, index) => ({ front: `Q${index}`, back: `A${index}` }));
    const result = normalizeGenerativeBlocks([{ type: 'flashcard-preview', props: { cards } }]);
    expect(result).toHaveLength(MAX_GENERATIVE_UI_BLOCKS);
  });
});

describe('normalizeGenerativeBlocks — identity', () => {
  it('returns the same array reference when nothing changes', () => {
    const blocks: GenerativeBlockIntent[] = [
      { type: 'stat-card', props: { title: 'T', value: 1 } },
      { type: 'text', props: { body: 'ok' } },
      { type: 'unknown-block', props: { anything: true } },
    ];
    expect(normalizeGenerativeBlocks(blocks)).toBe(blocks);
  });

  it('does not touch unknown block types', () => {
    const block: GenerativeBlockIntent = { type: 'custom-widget', props: { text: 'keep' } };
    expect(normalizeGenerativeBlocks([block])[0]).toBe(block);
  });
});
