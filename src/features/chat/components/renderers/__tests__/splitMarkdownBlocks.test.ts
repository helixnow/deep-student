import { describe, expect, it } from 'vitest';
import { splitMarkdownBlocks } from '../splitMarkdownBlocks';

describe('splitMarkdownBlocks', () => {
  it('keeps the active streaming block id stable while append-only content grows', () => {
    const first = splitMarkdownBlocks('第一句', true);
    const second = splitMarkdownBlocks('第一句，第二句', true);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]?.type).toBe('paragraph');
    expect(second[0]?.type).toBe('paragraph');
    expect(first[0]?.id).toBe(second[0]?.id);
  });

  it('treats a single-line $$...$$ as a self-closed math block', () => {
    const blocks = splitMarkdownBlocks('$$E=mc^2$$\n\n后续段落内容', false);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.type).toBe('math');
    expect(blocks[0]?.raw).toBe('$$E=mc^2$$');
    expect(blocks[0]?.isComplete).toBe(true);
    expect(blocks[1]?.type).toBe('paragraph');
    expect(blocks[1]?.raw).toBe('后续段落内容');
  });

  it('does not close a 4-backtick fence with an inner 3-backtick fence', () => {
    const content = '````md\n```js\nconst a = 1;\n```\n````\n\n尾随段落';
    const blocks = splitMarkdownBlocks(content, false);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.type).toBe('code');
    expect(blocks[0]?.isComplete).toBe(true);
    expect(blocks[0]?.raw).toContain('```js');
    expect(blocks[1]?.type).toBe('paragraph');
  });

  it('does not close a backtick fence with a tilde fence', () => {
    const content = '```\n~~~\ncode\n```';
    const blocks = splitMarkdownBlocks(content, false);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('code');
    expect(blocks[0]?.isComplete).toBe(true);
  });

  it('marks an unclosed streaming fence as incomplete', () => {
    const blocks = splitMarkdownBlocks('```python\nprint(1)', true);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('code');
    expect(blocks[0]?.isComplete).toBe(false);
  });
});
