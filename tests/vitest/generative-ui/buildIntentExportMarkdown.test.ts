import { describe, expect, it } from 'vitest';
import {
  ALL_BLOCK_TYPES,
  ALL_BLOCKS_MINIMAL_PROPS,
  buildAllBlocksIntent,
} from '@/features/generative-ui/demo/allBlocksFixture';
import { buildIntentExportMarkdown } from '@/features/generative-ui/utils/buildIntentExportMarkdown';
import type { GenerativeUIIntent } from '@/features/generative-ui/types';

describe('buildIntentExportMarkdown', () => {
  it('exports all 18 fixture types as readable markdown', () => {
    const intent = buildAllBlocksIntent();
    const md = buildIntentExportMarkdown(intent);

    expect(ALL_BLOCK_TYPES).toHaveLength(18);
    expect(intent.blocks).toHaveLength(18);
    expect(md.startsWith('# All 18 blocks')).toBe(true);
    expect(md.match(/^### /gm)).toHaveLength(18);

    for (const type of ALL_BLOCK_TYPES) {
      const props = ALL_BLOCKS_MINIMAL_PROPS[type] ?? {};
      const heading =
        (typeof props.title === 'string' && props.title) ||
        (typeof props.heading === 'string' && props.heading) ||
        (typeof props.topic === 'string' && props.topic) ||
        type;
      expect(md, `${type} heading`).toContain(`### ${heading}`);
    }

    expect(md).toMatch(/^指标: 42$/m);
    expect(md).toContain('正文内容');
    expect(md).toContain('**Markdown** 正文');
    expect(md).toContain('- [~] 复习到期卡');
    expect(md).toContain('- 类别: 周一, 周二');
    expect(md).toContain('- 张数: 3, 5');
    expect(md).toContain('| 主题 | 错误率 |');
    expect(md).toContain('| --- | --- |');
    expect(md).toContain('| 代数 | 35% |');
    expect(md).toContain('说明');
    expect(md).toContain('- 条目 A');
    expect(md).toContain('2 / 5');
    expect(md).toContain('- 操作');
    expect(md).toContain('- 键: 值');
    expect(md).toContain('- 正面: 正面');
    expect(md).toContain('- 背面: 背面');
    expect(md).toContain('- 2026-08-24: 3');
    expect(md).toContain('错误率: 35%');
    expect(md).toContain('加强练习');
    expect(md).toContain('- versionId: mv_all_blocks_demo');
    expect(md).toContain('- 发现 A');
    expect(md).toContain('- [ ] 检索');
    expect(md).toContain('报告正文 [paper-1]');
  });

  it('exports empty blocks as title-only markdown', () => {
    const intent: GenerativeUIIntent = {
      version: '1',
      meta: { title: 'Empty' },
      blocks: [],
    };
    expect(buildIntentExportMarkdown(intent)).toBe('# Empty');
  });

  it('does not invoke action-bar handlers (export is side-effect free)', () => {
    let called = false;
    const intent: GenerativeUIIntent = {
      version: '1',
      meta: { title: 'Actions' },
      blocks: [
        {
          type: 'action-bar',
          props: {
            actions: [{ id: 'boom', label: '危险操作', handler: () => { called = true; } }],
          },
        },
      ],
    };
    const md = buildIntentExportMarkdown(intent);
    expect(md).toContain('# Actions');
    expect(md).toContain('### action-bar');
    expect(md).toContain('- 危险操作');
    expect(called).toBe(false);
  });

  it('uses optional locale labels for generated markdown fields', () => {
    const intent: GenerativeUIIntent = {
      version: '1',
      blocks: [
        {
          type: 'chart',
          props: { kind: 'bar', categories: ['Mon'], series: [{ values: [1] }] },
        },
        {
          type: 'flashcard-preview',
          props: { deckName: 'Biology', front: 'Cell', back: '细胞', tags: ['exam'] },
        },
        {
          type: 'mistake-analysis',
          props: { errorRate: 25, mistakeCount: 2 },
        },
      ],
    };

    const md = buildIntentExportMarkdown(intent, {
      chartKind: 'Chart type',
      chartCategories: 'Categories',
      chartSeriesFallback: 'Series',
      flashcardDeck: 'Deck',
      flashcardFront: 'Front',
      flashcardBack: 'Back',
      flashcardTags: 'Tags',
      mistakeErrorRate: 'Error rate',
      mistakeCount: 'Mistakes',
    });

    expect(md).toContain('- Chart type: bar');
    expect(md).toContain('- Categories: Mon');
    expect(md).toContain('- Series: 1');
    expect(md).toContain('- Front: Cell');
    expect(md).toContain('- Back: 细胞');
    expect(md).toContain('Error rate: 25%');
    expect(md).toContain('Mistakes: 2');
  });
});
