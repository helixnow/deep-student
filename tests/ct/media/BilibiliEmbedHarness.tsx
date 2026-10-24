import React, { useRef } from 'react';
import { BilibiliEmbedPlayer } from '@/features/learning-hub/apps/views/media/BilibiliEmbedPlayer';
import type { MediaPlayerHandle } from '@/features/learning-hub/apps/views/media/mediaPlayerHandle';

export function BilibiliEmbedHarness() {
  const handleRef = useRef<MediaPlayerHandle | null>(null);
  return (
    <div style={{ width: '100%', height: 320 }}>
      <BilibiliEmbedPlayer link={{ kind: 'bilibili', version: 1, bvid: 'BV1xx411c7mD', aid: 1, cid: 2, page: 1, pageCount: 1, title: 'Lecture', part: '', owner: null, cover: null, durationMs: 60_000, url: 'https://www.bilibili.com/video/BV1xx411c7mD' }} handleRef={handleRef} />
    </div>
  );
}
