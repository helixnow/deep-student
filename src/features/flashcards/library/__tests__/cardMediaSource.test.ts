import { describe, expect, it } from 'vitest';

import {
  cardMediaSourceTexts,
  findCardMediaSource,
  findReviewCardMediaSource,
  stripCardMediaSourceRefs,
  withoutCardMediaSourceRefs,
} from '../cardMediaSource';

describe('card media source', () => {
  it('finds the first valid [媒体@id:mm:ss] anchor, back field first', () => {
    const card = {
      front: '正面 [媒体@file_front:00:10]',
      back: '正则化抑制过拟合\n[媒体@file_lec3:12:30]',
      fields: { Extra: '[媒体@file_extra:1:02:03]' },
    };
    expect(findCardMediaSource(cardMediaSourceTexts(card))).toEqual({
      resourceId: 'file_lec3',
      seconds: 750,
      label: '12:30',
    });
  });

  it('supports h:mm:ss and skips malformed anchors', () => {
    expect(findCardMediaSource(['[媒体@file_a:12:75] 后面 [媒体@file_b:1:02:03]'])).toEqual({
      resourceId: 'file_b',
      seconds: 3723,
      label: '1:02:03',
    });
    expect(findCardMediaSource(['[知识库-1]', '[12:30]', null, undefined])).toBeNull();
  });

  it('reads review cards with camelCase extra fields', () => {
    expect(findReviewCardMediaSource({
      id: 's1',
      front: 'Q',
      back: 'A',
      extraFields: { Source: '出处：[媒体@file_x:03:05]' },
    })).toEqual({ resourceId: 'file_x', seconds: 185, label: '03:05' });
    expect(findReviewCardMediaSource(null)).toBeNull();
  });
});

describe('stripCardMediaSourceRefs', () => {
  it('drops the trailing source line with or without a label', () => {
    expect(stripCardMediaSourceRefs('正则化抑制过拟合\n[媒体@file_lec3:12:30]')).toBe('正则化抑制过拟合');
    expect(stripCardMediaSourceRefs('答案\n出处：[媒体@file_lec3:12:30]')).toBe('答案');
    expect(stripCardMediaSourceRefs('答案<br>出处 [媒体@file_lec3:1:02:03]<br/>')).toBe('答案');
    expect(stripCardMediaSourceRefs('<p>答案</p><p>[媒体@file_lec3:12:30]</p>')).toBe('<p>答案</p>');
  });

  it('removes inline anchors but keeps surrounding words', () => {
    expect(stripCardMediaSourceRefs('见 [媒体@file_a:00:10] 与 [媒体@file_a:00:20] 两处'))
      .toBe('见  与  两处');
    expect(stripCardMediaSourceRefs('没有出处的背面')).toBe('没有出处的背面');
  });

  it('strips every text field of a review card without touching other data', () => {
    const card = {
      id: 's1',
      front: '什么是正则化？',
      back: '抑制过拟合\n[媒体@file_lec3:12:30]',
      text: undefined,
      tags: ['ml'],
      extraFields: { Back: '抑制过拟合\n[媒体@file_lec3:12:30]', Note: '无' },
    };
    expect(withoutCardMediaSourceRefs(card)).toEqual({
      ...card,
      back: '抑制过拟合',
      extraFields: { Back: '抑制过拟合', Note: '无' },
    });
  });
});
