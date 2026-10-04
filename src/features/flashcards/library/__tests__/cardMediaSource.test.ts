import { describe, expect, it } from 'vitest';

import { cardMediaSourceTexts, findCardMediaSource } from '../cardMediaSource';

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
});
