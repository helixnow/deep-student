import { describe, it, expect } from 'vitest';
import {
  applyAnchoredReplacement,
  buildSuggestionChange,
  findAnchoredIndex,
  markerOriginalText,
} from './suggestionAnchors';
import type { StreamingMarker } from './streamingMarkerParser';

const marker = (partial: Partial<StreamingMarker> & { type: StreamingMarker['type'] }): StreamingMarker => ({
  content: '',
  isComplete: true,
  ...partial,
});

describe('findAnchoredIndex（前后文锚定定位）', () => {
  it('目标唯一时直接命中', () => {
    expect(findAnchoredIndex('春天来了，花开了。', '花开了')).toBe(5);
  });

  it('目标多次出现时按前后文选择正确的一处（而非全局第一处）', () => {
    const text = '他说了很多。他说了很多，但没人听。';
    // 锚定第二处（前文是「很多。」）
    const index = findAnchoredIndex(text, '他说了很多', '他说了很多。', '，但没人听');
    expect(index).toBe(6);
  });

  it('无锚点时退化为第一处', () => {
    const text = 'abc abc';
    expect(findAnchoredIndex(text, 'abc')).toBe(0);
  });

  it('目标不存在返回 -1', () => {
    expect(findAnchoredIndex('正文', '不存在')).toBe(-1);
  });

  it('重复目标的前后文均不匹配时安全失败，不退化为第一处', () => {
    expect(findAnchoredIndex('重复内容。重复内容。', '重复内容', '不存在的前文', '不存在的后文'))
      .toBe(-1);
  });

  it('目标为空时按前后文接缝定位（撤销删除的重插场景）', () => {
    const text = '前面的话后面的话';
    expect(findAnchoredIndex(text, '', '前面的话', '后面的话')).toBe(4);
  });

  it('撤销删除时两侧锚点不能落在同一接缝则安全失败', () => {
    const text = '前面的话已经被用户改动';
    expect(findAnchoredIndex(text, '', '前面的话', '后面的话')).toBe(-1);
  });
});

describe('applyAnchoredReplacement（应用与撤销）', () => {
  it('替换锚点匹配度最高的一处', () => {
    const text = '好句子。坏句子在这里。好句子。';
    const result = applyAnchoredReplacement(text, '好句子', '优秀句子', '在这里。', '。');
    expect(result).not.toBeNull();
    expect(result!.text).toBe('好句子。坏句子在这里。优秀句子。');
  });

  it('定位失败（原文被手动改动）返回 null', () => {
    expect(applyAnchoredReplacement('正文', '不存在的片段', '替换')).toBeNull();
  });

  it('重复片段锚点失效时不误替换第一处', () => {
    expect(applyAnchoredReplacement(
      '这个词出现一次，这个词又出现一次。',
      '这个词',
      '替换词',
      '不匹配的前文',
      '不匹配的后文',
    )).toBeNull();
  });

  it('应用替换后可反向撤销回原文', () => {
    const text = '这个词用得不好，真的不好。';
    const applied = applyAnchoredReplacement(text, '不好', '欠妥', '这个词用得', '，真的');
    expect(applied!.text).toBe('这个词用得欠妥，真的不好。');
    // 撤销：replacement → original，锚点不变
    const undone = applyAnchoredReplacement(applied!.text, '欠妥', '不好', '这个词用得', '，真的');
    expect(undone!.text).toBe(text);
  });

  it('del 建议：应用删除后可按接缝撤销重插', () => {
    const text = '句子开头，多余的话，句子结尾。';
    const applied = applyAnchoredReplacement(text, '多余的话，', '', '句子开头，', '句子结尾。');
    expect(applied!.text).toBe('句子开头，句子结尾。');
    const undone = applyAnchoredReplacement(applied!.text, '', '多余的话，', '句子开头，', '句子结尾。');
    expect(undone!.text).toBe(text);
  });
});

describe('markerOriginalText（原文贡献）', () => {
  it('ins / pending 不计入原文，replace 取 oldText', () => {
    expect(markerOriginalText(marker({ type: 'ins', content: '新增内容' }))).toBe('');
    expect(markerOriginalText(marker({ type: 'pending', content: '<del' }))).toBe('');
    expect(markerOriginalText(marker({ type: 'replace', oldText: '旧', newText: '新' }))).toBe('旧');
    expect(markerOriginalText(marker({ type: 'text', content: '普通文本' }))).toBe('普通文本');
    expect(markerOriginalText(marker({ type: 'del', content: '要删的' }))).toBe('要删的');
  });
});

describe('buildSuggestionChange（从 marker 流构造锚定修改）', () => {
  const markers: StreamingMarker[] = [
    marker({ type: 'text', content: '开头的一段话。' }),
    marker({ type: 'ins', content: '（这是模型建议新增的内容，不在原文中）' }),
    marker({ type: 'replace', oldText: '不好的词', newText: '更好的词' }),
    marker({ type: 'text', content: '中间的文字。' }),
    marker({ type: 'del', content: '废话片段' }),
    marker({ type: 'text', content: '结尾。' }),
  ];

  it('replace marker：original/replacement 与前后文锚点正确', () => {
    const change = buildSuggestionChange(markers, 2);
    expect(change).not.toBeNull();
    expect(change!.original).toBe('不好的词');
    expect(change!.replacement).toBe('更好的词');
    // ins 内容不得混入锚点（它不在用户提交的原文中）
    expect(change!.before).toBe('开头的一段话。');
    expect(change!.after).toBe('中间的文字。废话片段结尾。');
    expect(change!.key).toBe('2:不好的词=>更好的词');
  });

  it('del marker：replacement 为空串', () => {
    const change = buildSuggestionChange(markers, 4);
    expect(change).not.toBeNull();
    expect(change!.original).toBe('废话片段');
    expect(change!.replacement).toBe('');
  });

  it('不可采纳的 marker 类型返回 null', () => {
    expect(buildSuggestionChange(markers, 0)).toBeNull(); // text
    expect(buildSuggestionChange(markers, 1)).toBeNull(); // ins
    expect(buildSuggestionChange(markers, 99)).toBeNull(); // 越界
  });

  it('锚点配合 applyAnchoredReplacement 能在重复片段中命中正确位置', () => {
    // 原文里「不好的词」出现两次，marker 指向的是第二次出现
    const dupMarkers: StreamingMarker[] = [
      marker({ type: 'text', content: '不好的词先出现一次。后面又写' }),
      marker({ type: 'replace', oldText: '不好的词', newText: '更好的词' }),
      marker({ type: 'text', content: '，这里才是要改的。' }),
    ];
    const originalEssay = '不好的词先出现一次。后面又写不好的词，这里才是要改的。';
    const change = buildSuggestionChange(dupMarkers, 1)!;
    const applied = applyAnchoredReplacement(
      originalEssay,
      change.original,
      change.replacement,
      change.before,
      change.after
    );
    expect(applied!.text).toBe('不好的词先出现一次。后面又写更好的词，这里才是要改的。');
  });
});
