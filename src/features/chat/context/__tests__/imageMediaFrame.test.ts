import { describe, expect, it } from 'vitest';

import { mediaFrameContextBlock } from '../definitions/image';

describe('media frame context on image refs', () => {
  it('wraps the surrounding transcript with the frame anchor', () => {
    expect(mediaFrameContextBlock({
      mediaResourceId: 'file_lec',
      mediaSeconds: 754,
      mediaTranscriptExcerpt: '[12:30] 正则化的直觉\n[12:41] 惩罚大权重',
    })).toEqual({
      type: 'text',
      text: '<media_frame_context media_ref="[媒体@file_lec:12:34]">\n[12:30] 正则化的直觉\n[12:41] 惩罚大权重\n</media_frame_context>',
    });
  });

  it('adds nothing for ordinary images or frames without transcript', () => {
    expect(mediaFrameContextBlock(undefined)).toBeNull();
    expect(mediaFrameContextBlock({ name: 'photo.png' })).toBeNull();
    expect(mediaFrameContextBlock({ mediaResourceId: 'file_lec', mediaSeconds: 3, mediaTranscriptExcerpt: '  ' })).toBeNull();
  });
});
