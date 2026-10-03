import { describe, expect, it } from 'vitest';
import { humanizeCitationMarkers } from '../cardCitations';

describe('humanizeCitationMarkers', () => {
  it('PDF 页码引用转成「第 N 页」', () => {
    expect(humanizeCitationMarkers('词根：contro-(相反)；出处：[PDF@file_ghtouXXDFW:1]')).toBe('词根：contro-(相反)；出处：第 1 页');
    expect(humanizeCitationMarkers('见 [PDF@tb_1:2-3] 与 [PDF@tb_1:1,5]')).toBe('见 第 2-3 页 与 第 1、5 页');
  });

  it('检索序号去掉，句末分隔符一并收拾', () => {
    expect(humanizeCitationMarkers('马氏规则：H 加到含 H 多的碳上 [知识库-1]。')).toBe('马氏规则：H 加到含 H 多的碳上。');
    expect(humanizeCitationMarkers('译文：很少有经济学家预料到。 [搜索-2]')).toBe('译文：很少有经济学家预料到。');
    expect(humanizeCitationMarkers('词根：vulner(伤)；[PDF@file_x]')).toBe('词根：vulner(伤)');
  });

  it('导图 / 题目集引用保留标题', () => {
    expect(humanizeCitationMarkers('参见 [思维导图:mm_abc:线性代数框架]')).toBe('参见 线性代数框架');
    expect(humanizeCitationMarkers('[题目集:exam_1:期中卷] 第 3 题')).toBe('期中卷 第 3 题');
  });

  it('没有标记时原样返回（包括普通方括号与 Cloze）', () => {
    const plain = 'Few economists {{c1::anticipated}} it. [注] [1]';
    expect(humanizeCitationMarkers(plain)).toBe(plain);
  });
});
