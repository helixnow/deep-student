import { describe, expect, it } from 'vitest';
import { parseMarkers, parseScore, removeScoreTag } from './markerParser';
import { parseStreamingContent } from './streamingMarkerParser';

const sampleWithInlineQuotes = `
空心者审视自我，求助他人，得到过一副药方：在忙碌中寻找一片原野。
<note text="开头引入自然，由社会现象切入主题，“空心病”的比喻新颖有趣">这一段</note>
情怀之种萌发，可引我们驻足细嗅蔷薇。
<good>而忙碌当为契机与肥料</good>
陶渊明误落尘网，因本爱丘山而走出忙碌之<err type="logic" explanation="陶渊明是主动辞官归隐，不是走出忙碌之笼，而是选择不忙碌的生活方式">笼</err>。
`;

describe('essay marker parser', () => {
  it('parses note/err attributes when attribute text contains quotes', () => {
    const markers = parseMarkers(sampleWithInlineQuotes);

    const note = markers.find((m) => m.type === 'note');
    expect(note?.content).toBe('这一段');
    expect(note?.comment).toContain('“空心病”的比喻新颖有趣');

    const err = markers.find((m) => m.type === 'err');
    expect(err?.content).toBe('笼');
    expect(err?.errorType).toBe('logic');
    expect(err?.explanation).toContain('不是走出忙碌之笼');
  });

  it('keeps streaming parser behavior consistent for inline quote cases', () => {
    const parsed = parseStreamingContent(sampleWithInlineQuotes, true);

    const note = parsed.markers.find((m) => m.type === 'note');
    const err = parsed.markers.find((m) => m.type === 'err');
    const rawTagLeak = parsed.markers.some(
      (m) => m.type === 'text' && /<note\b|<err\b/.test(m.content)
    );

    expect(note?.comment).toContain('“空心病”的比喻新颖有趣');
    expect(err?.explanation).toContain('不是走出忙碌之笼');
    expect(rawTagLeak).toBe(false);
  });

  it('does not duplicate content for nested markers (A6-08)', () => {
    const nested = '前文<note text="批注">外层<good>内层亮点</good>文本</note>后文';
    const markers = parseMarkers(nested);

    // 外层 note 完整保留，内层 good 不再作为独立标记重复输出
    const note = markers.find((m) => m.type === 'note');
    expect(note).toBeDefined();
    const standaloneGood = markers.filter((m) => m.type === 'good');
    expect(standaloneGood).toHaveLength(0);

    // 拼接结果不应出现"内层亮点"两次
    const joined = markers.map((m) => m.content).join('');
    expect(joined.match(/内层亮点/g)?.length).toBe(1);
  });

  it('parses score with both attribute orders (A6-08)', () => {
    const totalFirst = parseScore('<score total="8" max="10"><dim name="内容" score="4" max="5">好</dim></score>');
    expect(totalFirst?.total).toBe(8);
    expect(totalFirst?.maxTotal).toBe(10);

    const maxFirst = parseScore('<score max="10" total="8"><dim name="内容" score="4" max="5">好</dim></score>');
    expect(maxFirst?.total).toBe(8);
    expect(maxFirst?.maxTotal).toBe(10);

    expect(removeScoreTag('正文<score max="10" total="8">x</score>')).toBe('正文');
  });

  it('restores code blocks containing dollar signs intact (A6-09)', () => {
    const text = '说明文字\n```js\nconst price = "$100"; // $& $` $\' 都不该被破坏\n```\n结尾';
    const parsed = parseStreamingContent(text, true);
    const joined = parsed.markers.map((m) => m.content).join('');

    expect(joined).toContain('$100');
    expect(joined).not.toContain('__CODE_BLOCK_');
  });
});
