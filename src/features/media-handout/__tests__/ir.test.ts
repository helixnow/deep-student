import { describe, expect, it } from 'vitest';
import {
  collectFigureTimestamps,
  formatClock,
  parseClock,
  parseSectionBlocks,
  salvageBlocks,
} from '../ir';

const range = { startSec: 60, endSec: 180 };

describe('clock helpers', () => {
  it('parses mm:ss and h:mm:ss, rejects garbage', () => {
    expect(parseClock('03:25')).toBe(205);
    expect(parseClock('[1:02:03]')).toBe(3723);
    expect(parseClock('12')).toBeNull();
    expect(parseClock('aa:bb')).toBeNull();
    expect(parseClock(5)).toBeNull();
  });
  it('formats with hours only past one hour', () => {
    expect(formatClock(205)).toBe('03:25');
    expect(formatClock(3723.9)).toBe('1:02:03');
  });
});

describe('parseSectionBlocks', () => {
  it('accepts fenced JSON and cleans markdown residue and numbering', () => {
    const raw =
      '```json\n{"blocks":[{"type":"lead","text":"**主旨**"},{"type":"h2","text":"（一）定义"},' +
      '{"type":"list","ordered":true,"items":["1. 第一","2、第二"]},{"type":"note","text":"注意"}]}\n```';
    const blocks = parseSectionBlocks(raw, range);
    expect(blocks).toEqual([
      { type: 'lead', text: '主旨' },
      { type: 'h2', text: '定义' },
      { type: 'list', ordered: true, items: ['第一', '第二'] },
      { type: 'note', text: '注意' },
    ]);
  });

  it('drops out-of-range or malformed figures but keeps in-range ones', () => {
    const raw = JSON.stringify({
      blocks: [
        { type: 'para', text: 'x' },
        { type: 'figure', time: '01:30', caption: '图' },
        { type: 'figure', time: '09:00' },
        { type: 'figure', time: 'later' },
      ],
    });
    expect(parseSectionBlocks(raw, range)).toEqual([
      { type: 'para', text: 'x' },
      { type: 'figure', ts: 90, caption: '图' },
    ]);
  });

  it('throws on structural errors so the pipeline retries', () => {
    expect(() => parseSectionBlocks('not json', range)).toThrow();
    expect(() => parseSectionBlocks('{"items":[]}', range)).toThrow(/blocks/);
    expect(() => parseSectionBlocks('{"blocks":[{"type":"chart"}]}', range)).toThrow(/unknown block/);
    expect(() =>
      parseSectionBlocks('{"blocks":[{"type":"table","header":["a","b"],"rows":[["1"]]}]}', range),
    ).toThrow(/cells/);
    expect(() => parseSectionBlocks('{"blocks":[{"type":"para","text":"  "}]}', range)).toThrow(/no valid/);
  });

  it('validates tables', () => {
    const raw = JSON.stringify({
      blocks: [{ type: 'table', caption: '对比', header: ['A', 'B'], rows: [['1', '2']] }],
    });
    expect(parseSectionBlocks(raw, range)).toEqual([
      { type: 'table', caption: '对比', header: ['A', 'B'], rows: [['1', '2']] },
    ]);
  });
});

describe('salvageBlocks', () => {
  it('turns plain text into paragraphs', () => {
    expect(salvageBlocks('## 标题\n> 引用\n\n正文', 'fallback')).toEqual([
      { type: 'para', text: '标题' },
      { type: 'para', text: '引用' },
      { type: 'para', text: '正文' },
    ]);
  });
  it('degrades broken JSON or empty output to a single notice', () => {
    expect(salvageBlocks('{"blocks":[', 'fallback')).toEqual([{ type: 'note', text: 'fallback' }]);
    expect(salvageBlocks('   ', 'fallback')).toEqual([{ type: 'note', text: 'fallback' }]);
  });
});

it('collectFigureTimestamps dedups across sections in order', () => {
  expect(
    collectFigureTimestamps([
      { blocks: [{ type: 'figure', ts: 30 }, { type: 'para', text: 'x' }] },
      { blocks: [{ type: 'figure', ts: 90 }, { type: 'figure', ts: 30 }] },
    ]),
  ).toEqual([30, 90]);
});
