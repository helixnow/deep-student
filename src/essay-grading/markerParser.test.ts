import { describe, expect, it } from 'vitest';
import { parseMarkers } from './markerParser';
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
});
