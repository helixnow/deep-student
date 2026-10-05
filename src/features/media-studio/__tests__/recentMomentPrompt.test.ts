import { describe, expect, it, vi } from 'vitest';

vi.mock('@/features/media-handout', () => ({ useGenerateHandout: vi.fn(), openHandoutNote: vi.fn() }));
vi.mock('@/features/learning-hub/useReferenceToChat', () => ({ useReferenceToChat: vi.fn() }));

import { buildRecentMomentPrompt } from '../components/MediaStudyTabs';
import type { TranscriptSegment } from '@/features/learning-hub/apps/views/media/mediaTranscriptApi';

const t = (key: string, options?: Record<string, unknown>) => `${key} ${JSON.stringify(options)}`;
const segments: TranscriptSegment[] = [
  { idx: 0, startMs: 10_000, endMs: 20_000, text: '太早的内容', status: 'done' },
  { idx: 1, startMs: 95_000, endMs: 101_000, text: '正则化惩罚大权重', status: 'done' },
  { idx: 2, startMs: 101_000, endMs: 108_000, text: '所以模型更平滑', status: 'done' },
  { idx: 3, startMs: 130_000, endMs: 140_000, text: '还没播到', status: 'done' },
];

describe('buildRecentMomentPrompt', () => {
  it('quotes the minute before the playhead with its anchor', () => {
    const prompt = buildRecentMomentPrompt({ resourceId: 'file_lec', segments, getCurrentTime: () => 110 }, '第 3 讲', t);
    expect(prompt.startsWith('mediaStudio:ask.prompt.moment ')).toBe(true);
    const options = JSON.parse(prompt.slice('mediaStudio:ask.prompt.moment '.length));
    expect(options).toEqual({
      name: '第 3 讲',
      ref: '[媒体@file_lec:01:35]',
      quote: '> [01:35] 正则化惩罚大权重\n> [01:41] 所以模型更平滑',
    });
  });

  it('falls back to an anchor-only prompt when that minute has no transcript', () => {
    const prompt = buildRecentMomentPrompt({ resourceId: 'file_lec', segments: [], getCurrentTime: () => 30 }, '第 3 讲', t);
    expect(prompt).toBe('mediaStudio:ask.prompt.momentNoTranscript {"name":"第 3 讲","ref":"[媒体@file_lec:00:00]"}');
  });
});
