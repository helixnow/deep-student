import { describe, expect, it } from 'vitest';
import { MAX_GENERATIVE_UI_BLOCKS } from '@/features/generative-ui/schema';
import {
  lintGenerativeUIIntent,
} from '@/features/generative-ui/utils/lintGenerativeUIIntent';

const VALID_STAT_CARD = {
  version: '1',
  blocks: [{ type: 'stat-card', props: { title: 'Due', value: 2 } }],
};

function codesOf(input: unknown, options?: { actionIds?: string[] }): string[] {
  return lintGenerativeUIIntent(input, options).issues.map((issue) => issue.code);
}

describe('lintGenerativeUIIntent', () => {
  it('warns empty-blocks when blocks are missing or empty, and stays ok', () => {
    const missing = lintGenerativeUIIntent({ version: '1' });
    expect(missing.ok).toBe(true);
    expect(codesOf({ version: '1' })).toEqual(['empty-blocks']);

    const empty = lintGenerativeUIIntent({ version: '1', blocks: [] });
    expect(empty.ok).toBe(true);
    expect(empty.issues).toEqual([
      expect.objectContaining({ code: 'empty-blocks', severity: 'warning' }),
    ]);
  });

  it('errors on unknown-type and sets ok false', () => {
    const result = lintGenerativeUIIntent({
      version: '1',
      blocks: [{ type: 'not-a-real-block', props: { title: 'x' } }],
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: 'unknown-type',
        severity: 'error',
        path: 'blocks.0.type',
      }),
    ]);
  });

  it('errors on own className and fontSize keys', () => {
    const className = lintGenerativeUIIntent({
      version: '1',
      blocks: [{ type: 'stat-card', props: { title: 'Due', value: 2, className: 'text-red-500' } }],
    });
    expect(className.ok).toBe(false);
    expect(className.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'forbidden-classname',
          severity: 'error',
          path: 'blocks.0.props.className',
        }),
      ]),
    );

    const fontSize = lintGenerativeUIIntent({
      version: '1',
      blocks: [{ type: 'text', props: { body: 'hello', fontSize: 14 } }],
    });
    expect(fontSize.ok).toBe(false);
    expect(fontSize.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'forbidden-fontsize',
          severity: 'error',
          path: 'blocks.0.props.fontSize',
        }),
      ]),
    );
  });

  it('warns hex-color for hex string leaves in props', () => {
    const result = lintGenerativeUIIntent({
      version: '1',
      blocks: [{ type: 'stat-card', props: { title: 'Due', value: 2, subtitle: 'accent #FF5500' } }],
    });
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: 'hex-color',
        severity: 'warning',
        path: 'blocks.0.props.subtitle',
      }),
    ]);
  });

  it('warns duplicate-id for repeated block.id values', () => {
    const result = lintGenerativeUIIntent({
      version: '1',
      blocks: [
        { type: 'stat-card', id: 'card-1', props: { title: 'A', value: 1 } },
        { type: 'text', id: 'card-1', props: { body: 'dup' } },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: 'duplicate-id',
        severity: 'warning',
        path: 'blocks.1.id',
      }),
    ]);
  });

  it('warns blocks-truncated when length exceeds MAX_GENERATIVE_UI_BLOCKS', () => {
    const blocks = Array.from({ length: MAX_GENERATIVE_UI_BLOCKS + 1 }, (_, i) => ({
      type: 'stat-card',
      props: { title: `N${i}`, value: i },
    }));
    const result = lintGenerativeUIIntent({ version: '1', blocks });
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: 'blocks-truncated',
        severity: 'warning',
      }),
    ]);
    expect(blocks).toHaveLength(MAX_GENERATIVE_UI_BLOCKS + 1);
  });

  it('warns unknown-action on action-bar when actionIds is provided', () => {
    const intent = {
      version: '1',
      blocks: [
        {
          type: 'action-bar',
          props: {
            actions: [
              { id: 'start-review', label: 'Start' },
              { id: 'not-registered', label: 'Ghost' },
            ],
          },
        },
      ],
    };

    const withoutList = lintGenerativeUIIntent(intent);
    expect(withoutList.ok).toBe(true);
    expect(codesOf(intent)).toEqual([]);

    const withList = lintGenerativeUIIntent(intent, { actionIds: ['start-review'] });
    expect(withList.ok).toBe(true);
    expect(withList.issues).toEqual([
      expect.objectContaining({
        code: 'unknown-action',
        severity: 'warning',
        path: 'blocks.0.props.actions.1.id',
      }),
    ]);
  });

  it('returns ok true and no issues for a valid one-block stat-card', () => {
    const result = lintGenerativeUIIntent(VALID_STAT_CARD);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.issues.some((issue) => issue.code === 'empty-blocks')).toBe(false);
  });

  it('errors invalid-shape when input is not an object or blocks is not an array', () => {
    for (const input of [null, undefined, 'nope', 1, true, [{ type: 'stat-card' }]]) {
      const result = lintGenerativeUIIntent(input);
      expect(result.ok).toBe(false);
      expect(result.issues).toEqual([
        expect.objectContaining({ code: 'invalid-shape', severity: 'error' }),
      ]);
    }

    const badBlocks = lintGenerativeUIIntent({ version: '1', blocks: { type: 'stat-card' } });
    expect(badBlocks.ok).toBe(false);
    expect(codesOf({ version: '1', blocks: { type: 'stat-card' } })).toEqual(['invalid-shape']);
  });

  it('does not mutate the input object', () => {
    const input = {
      version: '1',
      blocks: [{ type: 'stat-card', props: { title: 'Due', value: 2, className: 'x' } }],
    };
    const snapshot = structuredClone(input);
    lintGenerativeUIIntent(input);
    expect(input).toEqual(snapshot);
  });
});
