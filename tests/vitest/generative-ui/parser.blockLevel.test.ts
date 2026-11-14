import { describe, it, expect } from 'vitest';
import {
  sanitizeGenerativeJsonBuffer,
  extractClosedBlockObjectSlices,
  tryParsePartialIntent,
  GenerativeUIStreamParser,
} from '@/features/generative-ui/parser';

describe('generative-ui parser block-level', () => {
  it('strips markdown fences', () => {
    expect(sanitizeGenerativeJsonBuffer('```json\n{"version":"1"}\n```')).toBe('{"version":"1"}');
  });

  it.each([false, true])('preserves code fences inside markdown blocks (outer fence: %s)', (wrapped) => {
    const body = '示例：\n```js\nconst count = 1;\n```';
    const json = JSON.stringify({ version: '1', blocks: [{ type: 'markdown', props: { body } }] });
    const source = wrapped ? `说明：\n\`\`\`json\n${json}\n\`\`\`` : json;

    expect(sanitizeGenerativeJsonBuffer(source)).toBe(json);
    expect(tryParsePartialIntent(source)?.blocks[0]?.props?.body).toBe(body);
  });

  it('commits a markdown block containing code fences before the stream finishes', () => {
    const body = '```js\nconst count = 1;\n```';
    const block = JSON.stringify({ type: 'markdown', props: { body } });
    const parser = new GenerativeUIStreamParser();
    parser.appendChunk('```json\n{"version":"1","blocks":[');
    const partial = parser.appendChunk(block);
    expect(partial.committedBlockCount).toBe(1);
    expect(partial.intent?.blocks[0]?.props?.body).toBe(body);
    parser.appendChunk(']}\n```');
    expect(parser.finalize()?.blocks[0]?.props?.body).toBe(body);
  });

  it('extracts complete blocks from truncated stream', () => {
    const partial =
      '{"version":"1","blocks":[{"type":"text","props":{"body":"a"}},{"type":"stat-card","props":{"title":"T","value":1';
    const slices = extractClosedBlockObjectSlices(partial);
    expect(slices).toHaveLength(1);
    const intent = tryParsePartialIntent(partial);
    expect(intent?.blocks).toHaveLength(1);
    expect(intent?.blocks[0]?.type).toBe('text');
  });

  it('parser append keeps last-good when tail is incomplete', () => {
    const complete =
      '{"version":"1","blocks":[{"type":"text","props":{"body":"hello"}}]}';
    const parser = new GenerativeUIStreamParser();
    parser.append(complete);
    parser.append(',{"type":"stat-card","props":{"title":"X","val');
    expect(parser.append('')?.blocks.length).toBeGreaterThanOrEqual(1);
  });

  it('does not drop earlier good blocks when a closed slice fails validation', () => {
    const parser = new GenerativeUIStreamParser();
    parser.appendChunk(
      '{"version":"1","blocks":[{"type":"text","props":{"body":"good"}}',
    );
    const snap = parser.appendChunk(',{"type":""},{"type":"stat-card","props":{"title":"T","value":1}}]');
    expect(snap.intent?.blocks.map((b) => b.type)).toEqual(['text', 'stat-card']);
  });

  it('does not treat a meta title of "blocks" as the blocks array', () => {
    const partial =
      '{"version":"1","meta":{"title":"blocks","description":"[preview]"},"blocks":[{"type":"text","props":{"body":"keep"}}';
    expect(extractClosedBlockObjectSlices(partial)).toHaveLength(1);
    expect(tryParsePartialIntent(partial)?.blocks.map((block) => block.props?.body)).toEqual([
      'keep',
    ]);
  });

  it('does not replay recovered no-id blocks after a malformed tail arrives', () => {
    const parser = new GenerativeUIStreamParser();
    const recovered = parser.appendChunk(
      '{"version":"1","blocks":[{"type":"text","props":{"body":"first"}},{"type":""},{"type":"text","props":{"body":"third"}}]}',
    );
    expect(recovered.intent?.blocks.map((block) => block.props?.body)).toEqual(['first', 'third']);

    const afterTail = parser.appendChunk(' trailing-garbage');
    expect(afterTail.intent?.blocks.map((block) => block.props?.body)).toEqual(['first', 'third']);
    expect(afterTail.committedBlockCount).toBe(2);
  });
});
