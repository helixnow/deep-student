import { describe, expect, it } from 'vitest';
import { parseMarkers, parseScore, removeScoreTag } from './markerParser';
import { parseStreamingContent, removeSectionTags } from './streamingMarkerParser';

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

  // ---- 流式：跨 chunk 不完整标记 ----

  it('holds cross-chunk incomplete markers in pending during streaming', () => {
    // err 标签在 chunk 边界被截断（属性值未接收完）
    const parsed = parseStreamingContent('前文<err type="logic" explanation="解释还没', false);
    expect(parsed.pendingText).toContain('<err');
    // 前文已确认，不应整段进 pending
    const confirmedText = parsed.markers.filter((m) => m.type === 'text').map((m) => m.content).join('');
    expect(confirmedText).toContain('前文');
    // 原始标签不应作为确认文本泄漏
    expect(confirmedText).not.toContain('<err');
  });

  it('holds truncated tag-name fragments in pending (e.g. "<sec")', () => {
    const parsed = parseStreamingContent('正文<sec', false);
    expect(parsed.pendingText).toBe('<sec');
  });

  it('extends pending back to the unclosed open tag when close tag is cut mid-stream', () => {
    // </de 尚未接收完整，pending 应从 <del 开始而不是从 </de 开始
    const parsed = parseStreamingContent('前文<del reason="多余">冗词</de', false);
    expect(parsed.pendingText.startsWith('<del')).toBe(true);
    const confirmedText = parsed.markers.filter((m) => m.type === 'text').map((m) => m.content).join('');
    expect(confirmedText).not.toContain('<del');
  });

  // ---- 流式：正文裸 '<' 不应被判为不完整标记 ----

  it('does not treat bare "<" in prose as an incomplete marker during streaming', () => {
    const parsed = parseStreamingContent('数学上 a < b 且 i<3 是成立的', false);
    expect(parsed.pendingText).toBe('');
    const joined = parsed.markers.map((m) => m.content).join('');
    expect(joined).toContain('a < b');
    expect(joined).toContain('i<3');
  });

  it('pends the whole score block while it is still streaming (no raw tag leak)', () => {
    // <score> 未闭合，但内部已有完整的 </dim>；pending 应回溯到 <score 开头
    const parsed = parseStreamingContent(
      '正文<score total="8" max="10"><dim name="内容" score="4" max="5">好</dim>',
      false
    );
    expect(parsed.pendingText.startsWith('<score')).toBe(true);
    const confirmedText = parsed.markers.filter((m) => m.type === 'text').map((m) => m.content).join('');
    expect(confirmedText).toBe('正文');
  });

  it('still pends unclosed known tags even with a later bare "<"', () => {
    const parsed = parseStreamingContent('<del reason="x">部分内容 a < b', false);
    // <del 未闭合，整段（含裸 <）应进 pending，等待 </del> 到达
    expect(parsed.pendingText.startsWith('<del')).toBe(true);
  });

  // ---- section 标签按名配对 ----

  it('removes interleaved sections by tag-name pairing without leaking content', () => {
    // 交错嵌套：polish 内部包着 model-essay，旧实现会把 </section-model-essay>
    // 误当作 polish 的结束，导致 "P2</section-polish>" 泄漏进正文
    const text = '正文<section-polish>P1<section-model-essay>M</section-model-essay>P2</section-polish>尾部';
    const result = removeSectionTags(text);
    expect(result).toBe('正文尾部');
    expect(result).not.toContain('</section-polish>');
  });

  it('strips unclosed section opening tags to end during streaming', () => {
    expect(removeSectionTags('正文<section-model-essay>范文流式中')).toBe('正文');
  });

  it('cleans orphan section close tags', () => {
    expect(removeSectionTags('正文</section-polish>尾部')).toBe('正文尾部');
  });

  // ---- dim 属性任意顺序 + 评语含 '<' ----

  it('parses dim attributes in any order', () => {
    const score = parseScore(
      '<score max="10" total="8">' +
      '<dim score="4" max="5" name="内容">言之有物</dim>' +
      '<dim max="5" name="结构" score="3">层次清晰</dim>' +
      '</score>'
    );
    expect(score?.dimensions).toHaveLength(2);
    expect(score?.dimensions[0]).toMatchObject({ name: '内容', score: 4, maxScore: 5, comment: '言之有物' });
    expect(score?.dimensions[1]).toMatchObject({ name: '结构', score: 3, maxScore: 5, comment: '层次清晰' });
  });

  it('allows "<" inside dim comments (lazy match to </dim>)', () => {
    const score = parseScore(
      '<score total="8" max="10"><dim name="逻辑" score="4" max="5">论证密度 a < b，可加强</dim></score>'
    );
    expect(score?.dimensions[0]?.comment).toBe('论证密度 a < b，可加强');
  });

  // ---- 超满分统一 clamp（与后端一致） ----

  it('clamps over-max totals and dim scores to their max', () => {
    const score = parseScore(
      '<score total="85" max="9"><dim name="任务完成" score="7" max="5">超标</dim></score>'
    );
    expect(score?.total).toBe(9);
    expect(score?.maxTotal).toBe(9);
    expect(score?.grade).toBe('excellent');
    expect(score?.dimensions[0]?.score).toBe(5);
    expect(score?.isComplete).toBe(true);

    const streaming = parseStreamingContent('<score total="85" max="9"></score>', true);
    expect(streaming.score?.total).toBe(9);
  });

  it('clamps negative totals to zero', () => {
    const score = parseScore('<score total="-3" max="10"></score>');
    expect(score?.total).toBe(0);
    expect(score?.grade).toBe('fail');
  });

  // ---- score/removeScoreTag 宽松匹配 ----

  it('removes malformed score tags so they do not leak into body text', () => {
    expect(removeScoreTag('正文<score total="8">畸形无 max</score>')).toBe('正文');
    const parsed = parseStreamingContent('正文<score total="8">畸形无 max</score>', true);
    expect(parsed.score).toBeNull();
    const joined = parsed.markers.map((m) => m.content).join('');
    expect(joined).not.toContain('<score');
  });

  // ---- 畸形 replace 容错 ----

  it('parses self-closing replace missing "/" as best effort (open-tag form)', () => {
    const markers = parseMarkers('他<replace old="想" new="要" reason="搭配">去');
    const replace = markers.find((m) => m.type === 'replace');
    expect(replace?.oldText).toBe('想');
    expect(replace?.newText).toBe('要');
    expect(replace?.reason).toBe('搭配');
    const joined = markers.map((m) => m.content).join('');
    expect(joined).not.toContain('<replace');
  });

  it('parses malformed paired replace form and consumes its close tag', () => {
    const markers = parseMarkers('他<replace old="想" new="要">想</replace>去');
    const replace = markers.find((m) => m.type === 'replace');
    expect(replace?.oldText).toBe('想');
    expect(replace?.newText).toBe('要');
    const joined = markers.map((m) => m.content).join('');
    expect(joined).not.toContain('</replace>');
    // 同起点的短匹配（仅开始标签）被"更长优先"跳过，不产生重复 replace
    expect(markers.filter((m) => m.type === 'replace')).toHaveLength(1);
  });

  it('degrades attribute-less replace tags to text safely', () => {
    const markers = parseMarkers('前<replace>后');
    expect(markers.every((m) => m.type === 'text')).toBe(true);
    expect(markers.map((m) => m.content).join('')).toContain('<replace>');
  });

  it('handles malformed replace consistently in streaming parser', () => {
    const parsed = parseStreamingContent('他<replace old="想" new="要" reason="搭配">去', true);
    const replace = parsed.markers.find((m) => m.type === 'replace');
    expect(replace?.oldText).toBe('想');
    expect(replace?.newText).toBe('要');
  });

  // ---- 交错/嵌套 marker 不丢内容 ----

  it('keeps overlapping marker tails as text instead of dropping content (streaming)', () => {
    const nested = '前文<note text="批注">外层<good>内层亮点</good>文本</note>后文';
    const parsed = parseStreamingContent(nested, true);
    const joined = parsed.markers.map((m) => m.content).join('');
    // 内层亮点只出现一次（在外层 note 内），后文不丢失
    expect(joined.match(/内层亮点/g)?.length).toBe(1);
    expect(joined).toContain('后文');
    expect(parsed.markers.filter((m) => m.type === 'good')).toHaveLength(0);
  });

  // ---- 中文错误类型词汇表 ----

  it('parses Chinese-specific error types', () => {
    const markers = parseMarkers(
      '<err type="idiom_misuse" explanation="成语误用">首当其冲</err>' +
      '<err type="redundancy" explanation="语义重复">免费赠送</err>'
    );
    const types = markers.filter((m) => m.type === 'err').map((m) => m.errorType);
    expect(types).toEqual(['idiom_misuse', 'redundancy']);
  });
});

describe('nested marker tag stripping', () => {
  it('strips raw nested tags from note content (offline parser)', () => {
    const markers = parseMarkers('<note text="批注">外层<good>内层亮点</good>文本</note>');
    const note = markers.find((m) => m.type === 'note');
    expect(note?.content).toBe('外层内层亮点文本');
    expect(note?.content).not.toContain('<good');
  });

  it('strips raw nested tags from marker content (streaming parser)', () => {
    const parsed = parseStreamingContent(
      '<err type="logic" explanation="e">前<ins>补充</ins>后</err>',
      true
    );
    const err = parsed.markers.find((m) => m.type === 'err');
    expect(err?.content).toBe('前补充后');
    expect(err?.content).not.toContain('<ins');
  });

  it('strips self-closing replace tags nested inside del content', () => {
    const parsed = parseStreamingContent(
      '<del reason="r">冗词<replace old="a" new="b"/>结尾</del>',
      true
    );
    const del = parsed.markers.find((m) => m.type === 'del');
    expect(del?.content).toBe('冗词结尾');
  });
});

describe('code block placeholder restoration', () => {
  it('restores code blocks inside non-text marker content', () => {
    const parsed = parseStreamingContent(
      '前文<del reason="r">删除 ```js\nconst a = 1;\n``` 之后</del>尾部',
      true
    );
    const del = parsed.markers.find((m) => m.type === 'del');
    expect(del?.content).toContain('const a = 1;');
    expect(del?.content).not.toContain('__CODE_BLOCK_');
  });

  it('restores code blocks inside pending text during streaming', () => {
    const parsed = parseStreamingContent('<del>片段```py\nx = 2\n```未闭合', false);
    expect(parsed.pendingText).toContain('x = 2');
    expect(parsed.pendingText).not.toContain('__CODE_BLOCK_');
    const pending = parsed.markers.find((m) => m.type === 'pending');
    expect(pending?.content).toContain('x = 2');
    expect(pending?.content).not.toContain('__CODE_BLOCK_');
  });
});

describe('truncated stream finalization', () => {
  it('strips an unclosed score block when the stream ends mid-score', () => {
    const parsed = parseStreamingContent(
      '正文<score total="8" max="10"><dim name="内容" score="4" max="5">好',
      true
    );
    expect(parsed.score).toBeNull();
    const joined = parsed.markers.map((m) => m.content).join('');
    expect(joined).toBe('正文');
    expect(joined).not.toContain('<score');
  });

  it('cleans orphan score close tags in both streaming and complete modes', () => {
    for (const isComplete of [true, false]) {
      const parsed = parseStreamingContent('正文</score>尾部', isComplete);
      const joined = parsed.markers.map((m) => m.content).join('');
      expect(joined).toContain('正文');
      expect(joined).toContain('尾部');
      expect(joined).not.toContain('</score>');
    }
  });
});

describe('incremental streaming parse', () => {
  const fullText =
    '开篇正文<good>亮点句子</good>过渡' +
    '<err type="grammar" explanation="主谓不一致">病句内容</err>中段' +
    '<replace old="旧词" new="新词" reason="搭配"/>后段' +
    '<del reason="冗余">多余的词</del>' +
    '<note text="结构紧凑">收束句</note>结尾文字';

  const splitPoints = [3, 10, 18, 25, 40, 55, 70, 90, 110, 130];

  function chunksOf(text: string): string[] {
    const chunks: string[] = [];
    let prev = 0;
    for (const p of splitPoints) {
      if (p >= text.length) break;
      chunks.push(text.slice(prev, p));
      prev = p;
    }
    chunks.push(text.slice(prev));
    return chunks;
  }

  it('produces the same intermediate results as cold full re-parse at every chunk boundary', () => {
    const chunks = chunksOf(fullText);

    // 完成态解析会清空增量缓存，确保热路径从确定状态开始
    parseStreamingContent('', true);

    // 热路径：按 chunk 递进，增量缓存生效
    let acc = '';
    const warmResults = chunks.map((chunk) => {
      acc += chunk;
      return parseStreamingContent(acc, false);
    });

    // 冷路径：每个前缀前先用完成态解析清空增量缓存，再全量解析对比
    let acc2 = '';
    chunks.forEach((chunk, i) => {
      acc2 += chunk;
      parseStreamingContent('', true);
      const cold = parseStreamingContent(acc2, false);
      expect(warmResults[i].markers).toEqual(cold.markers);
      expect(warmResults[i].pendingText).toBe(cold.pendingText);
    });
  });

  it('reuses stable marker objects across streaming chunks (incremental cache engaged)', () => {
    parseStreamingContent('', true);
    const first = parseStreamingContent('<good>亮点</good>之后', false);
    const second = parseStreamingContent('<good>亮点</good>之后继续<err type="a">x</err>', false);
    const firstGood = first.markers.find((m) => m.type === 'good');
    const secondGood = second.markers.find((m) => m.type === 'good');
    expect(firstGood).toBeDefined();
    expect(secondGood).toBe(firstGood);
  });

  it('final complete parse equals a one-shot complete parse after chunked streaming', () => {
    parseStreamingContent('', true);
    const oneShot = parseStreamingContent(fullText, true);
    const expected = {
      markers: oneShot.markers,
      pendingText: oneShot.pendingText,
      score: oneShot.score,
    };

    parseStreamingContent('', true);
    let acc = '';
    for (const chunk of chunksOf(fullText)) {
      acc += chunk;
      parseStreamingContent(acc, false);
    }
    const finalParse = parseStreamingContent(fullText, true);
    expect(finalParse.markers).toEqual(expected.markers);
    expect(finalParse.pendingText).toBe(expected.pendingText);
    expect(finalParse.score).toEqual(expected.score);
  });
});

describe('malicious / adversarial input resilience', () => {
  it('does not crash or pend on a flood of bare "<" characters', () => {
    const text = '开头' + '<'.repeat(2000) + '结尾';
    const parsed = parseStreamingContent(text, false);
    const joined = parsed.markers.map((m) => m.content).join('');
    expect(joined).toContain('开头');
    expect(joined).toContain('结尾');
  });

  it('bounds pending lookbehind for a pathologically long unclosed tag', () => {
    const text = '<del reason="x">' + '内'.repeat(4000);
    const parsed = parseStreamingContent(text, false);
    // 超过回溯窗口的未闭合标签按模型输出错误处理，降级为原样文本而非无限 pending
    expect(parsed.pendingText).toBe('');
    const joined = parsed.markers.map((m) => m.content).join('');
    expect(joined).toContain('内');
  });

  it('ignores unknown tag-like tokens in prose and still parses later markers', () => {
    const parsed = parseStreamingContent('词条<errata 是词>之后<good>亮点</good>', false);
    expect(parsed.pendingText).toBe('');
    const good = parsed.markers.find((m) => m.type === 'good');
    expect(good?.content).toBe('亮点');
  });

  it('does not pair close tags with prose tokens sharing a tag-name prefix', () => {
    const text = '<err type="a">壹</err>中间<errno 变量>说明<good>好</good>';
    const parsed = parseStreamingContent(text, false);
    const err = parsed.markers.find((m) => m.type === 'err');
    const good = parsed.markers.find((m) => m.type === 'good');
    expect(err?.content).toBe('壹');
    expect(good?.content).toBe('好');
    expect(parsed.pendingText).toBe('');
  });

  it('survives attribute values stuffed with quote characters', () => {
    const parsed = parseStreamingContent(
      '<note text="包含 "引号" 的批注">被批注</note>后文',
      true
    );
    const note = parsed.markers.find((m) => m.type === 'note');
    expect(note?.content).toBe('被批注');
    expect(note?.comment).toContain('引号');
  });

  it('degrades gracefully (no crash, no content loss) when attribute values contain ">"', () => {
    const raw = '<note text="内含 <尖括号> 的批注">被批注</note>后文';
    const parsed = parseStreamingContent(raw, true);
    const joined = parsed.markers.map((m) => m.content).join('');
    expect(joined).toContain('被批注');
    expect(joined).toContain('后文');
  });
});
