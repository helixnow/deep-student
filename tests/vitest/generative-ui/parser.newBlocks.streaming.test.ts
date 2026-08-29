/**
 * 流式 parser：半截 markdown / chart / steps / table 不覆盖 last-good，
 * 已闭合的新块仍按真实最小合法 props 提交。
 */
import { describe, it, expect } from 'vitest';
import type { ZodTypeAny } from 'zod';
import {
  GenerativeUIStreamParser,
  extractClosedBlockObjectSlices,
  tryParsePartialIntent,
} from '@/features/generative-ui/parser';
import { ALL_BLOCKS_MINIMAL_PROPS } from '@/features/generative-ui/demo/allBlocksFixture';
import { markdownPropsSchema } from '@/features/generative-ui/components/MarkdownBlock';
import { chartBlockPropsSchema } from '@/features/generative-ui/components/ChartBlock';
import { stepsBlockPropsSchema } from '@/features/generative-ui/components/StepsBlock';
import { tableBlockPropsSchema } from '@/features/generative-ui/components/TableBlock';

const NEW_BLOCK_TYPES = ['markdown', 'chart', 'steps', 'table'] as const;
type NewBlockType = (typeof NEW_BLOCK_TYPES)[number];

const PROPS_SCHEMA: Record<NewBlockType, ZodTypeAny> = {
  markdown: markdownPropsSchema,
  chart: chartBlockPropsSchema,
  steps: stepsBlockPropsSchema,
  table: tableBlockPropsSchema,
};

function minimalProps(type: NewBlockType) {
  const props = ALL_BLOCKS_MINIMAL_PROPS[type];
  if (!props) throw new Error(`missing minimal props for ${type}`);
  return props;
}

function closedBlockJson(type: NewBlockType): string {
  return JSON.stringify({ type, props: minimalProps(type) });
}

/** 半截对象：永远丢掉最外层 `}`，再从中段切开，保证切片未闭合 */
function halfCutBlockJson(type: NewBlockType): string {
  const full = closedBlockJson(type);
  const open = full.endsWith('}') ? full.slice(0, -1) : full;
  return open.slice(0, Math.max(16, Math.floor(open.length * 0.6)));
}

/** 停在 `"props":`，补 `}]}` / `}}` 也无法 parse，避免误造 last-good */
function uncloseableNewBlockPrefix(type: NewBlockType): string {
  return `{"version":"1","blocks":[{"type":"${type}","props":`;
}

function streamPrefix(closed: NewBlockType[], halfCut: NewBlockType): string {
  const closedJson = closed.map(closedBlockJson).join(',');
  const sep = closedJson ? ',' : '';
  return `{"version":"1","blocks":[${closedJson}${sep}${halfCutBlockJson(halfCut)}`;
}

function expectLegalCommitted(
  blocks: Array<{ type?: string; props?: Record<string, unknown> }> | undefined,
  types: NewBlockType[],
) {
  expect(blocks).toHaveLength(types.length);
  types.forEach((type, index) => {
    const block = blocks?.[index];
    expect(block?.type).toBe(type);
    const parsed = PROPS_SCHEMA[type].safeParse(block?.props);
    expect(parsed.success, `${type} props must stay schema-legal`).toBe(true);
    expect(block?.props).toEqual(minimalProps(type));
  });
}

describe('new-block streaming last-good', () => {
  it.each(NEW_BLOCK_TYPES)(
    'closed %s stays last-good while the next new-block is half-cut',
    (closedType) => {
      const halfCut = NEW_BLOCK_TYPES[(NEW_BLOCK_TYPES.indexOf(closedType) + 1) % NEW_BLOCK_TYPES.length]!;
      const prefix = streamPrefix([closedType], halfCut);

      expect(extractClosedBlockObjectSlices(prefix)).toHaveLength(1);

      const partial = tryParsePartialIntent(prefix);
      expectLegalCommitted(partial?.blocks, [closedType]);

      const parser = new GenerativeUIStreamParser();
      const snap = parser.appendChunk(prefix);
      expect(snap.phase).toBe('streaming');
      expect(snap.committedBlockCount).toBe(1);
      expectLegalCommitted(snap.intent?.blocks, [closedType]);

      const finalized = parser.finalize();
      expectLegalCommitted(finalized?.blocks, [closedType]);
      expect(parser.getSnapshot().intent?.blocks).toEqual(finalized?.blocks);
    },
  );

  it.each(NEW_BLOCK_TYPES)('half-cut first %s does not invent a last-good block', (type) => {
    const prefix = uncloseableNewBlockPrefix(type);
    expect(extractClosedBlockObjectSlices(prefix)).toHaveLength(0);
    expect(tryParsePartialIntent(prefix)).toBeNull();

    const parser = new GenerativeUIStreamParser();
    const snap = parser.appendChunk(prefix);
    expect(snap.committedBlockCount).toBe(0);
    expect(snap.intent).toBeNull();
    expect(parser.finalize()).toBeNull();
  });

  it('keeps all four closed new-blocks when a trailing slice is incomplete', () => {
    const prefix = streamPrefix([...NEW_BLOCK_TYPES], 'chart');
    expect(extractClosedBlockObjectSlices(prefix)).toHaveLength(4);

    const parser = new GenerativeUIStreamParser();
    const snap = parser.appendChunk(prefix);
    expect(snap.committedBlockCount).toBe(4);
    expectLegalCommitted(snap.intent?.blocks, [...NEW_BLOCK_TYPES]);
    expectLegalCommitted(parser.finalize()?.blocks, [...NEW_BLOCK_TYPES]);
  });

  it('incrementally commits closed new-blocks and holds last-good across a half-cut tail', () => {
    const parser = new GenerativeUIStreamParser();

    const first = parser.appendChunk(`{"version":"1","blocks":[${closedBlockJson('markdown')}`);
    expect(first.committedBlockCount).toBe(1);
    expectLegalCommitted(first.intent?.blocks, ['markdown']);

    const afterChart = parser.appendChunk(`,${closedBlockJson('chart')}`);
    expect(afterChart.committedBlockCount).toBe(2);
    expectLegalCommitted(afterChart.intent?.blocks, ['markdown', 'chart']);

    const halfSteps = parser.appendChunk(`,${halfCutBlockJson('steps')}`);
    expect(halfSteps.committedBlockCount).toBe(2);
    expectLegalCommitted(halfSteps.intent?.blocks, ['markdown', 'chart']);
    expect(halfSteps.intent?.blocks.map((b) => b.type)).not.toContain('steps');

    const afterSteps = parser.appendChunk(closedBlockJson('steps').slice(halfCutBlockJson('steps').length));
    expect(afterSteps.committedBlockCount).toBe(3);
    expectLegalCommitted(afterSteps.intent?.blocks, ['markdown', 'chart', 'steps']);

    const halfTable = parser.appendChunk(`,${halfCutBlockJson('table')}`);
    expect(halfTable.committedBlockCount).toBe(3);
    expectLegalCommitted(halfTable.intent?.blocks, ['markdown', 'chart', 'steps']);

    const done = parser.appendChunk(`${closedBlockJson('table').slice(halfCutBlockJson('table').length)}]}`);
    expect(done.committedBlockCount).toBe(4);
    expectLegalCommitted(done.intent?.blocks, [...NEW_BLOCK_TYPES]);
    expectLegalCommitted(parser.finalize()?.blocks, [...NEW_BLOCK_TYPES]);
  });

  it('does not drop earlier new-blocks when a half-cut tail later fails validation', () => {
    const parser = new GenerativeUIStreamParser();
    parser.appendChunk(`{"version":"1","blocks":[${closedBlockJson('table')},${closedBlockJson('steps')}`);
    const snap = parser.appendChunk(',{"type":"markdown","props":{"body":');
    expect(snap.committedBlockCount).toBe(2);
    expectLegalCommitted(snap.intent?.blocks, ['table', 'steps']);
    expect(parser.finalize()?.blocks.map((b) => b.type)).toEqual(['table', 'steps']);
  });
});
