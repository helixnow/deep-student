import { afterEach, expect, it } from 'vitest';
import { chunkTranscriptForGeneration, containsMediaAnchor, firstMediaCitation, formatMediaClock, mediaCitationSecondsFor, parseClock, parseTimestampedLine, prepareMediaTextForGeneration, mediaFileName } from '../src/media-source.ts';
import { storageFixture } from './storage.ts';

const fixtures: ReturnType<typeof storageFixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.dispose(); });
const transcript = (lines: [number, string][]) => lines.map(([s, text]) => `[${formatMediaClock(s)}] ${text}`).join('\n');
it('clock_round_trips_and_switches_to_hours', () => {
  expect(formatMediaClock(0)).toBe('00:00');
  expect(formatMediaClock(605)).toBe('10:05');
  expect(formatMediaClock(3725)).toBe('1:02:05');
  expect(parseClock('10:05')).toBe(605);
  expect(parseClock('1:02:05')).toBe(3725);
  expect(parseClock('75:00')).toBe(4500);
  expect(parseClock('10:60')).toBeNull();
  expect(parseClock('a:05')).toBeNull();
});
it('parses_line_timestamps_and_ranges', () => {
  expect(parseTimestampedLine('[03:25] 正则化')).toEqual([205, '正则化']);
  expect(parseTimestampedLine('  [1:00:01 - 1:00:09] 小结')).toEqual([3601, '小结']);
  expect(parseTimestampedLine('[知识库-1] 不是时间')).toBeNull();
  expect(parseTimestampedLine('没有时间戳')).toBeNull();
});
it('finds_first_media_citation', () => {
  expect(firstMediaCitation('见 [知识库-1] 与 [媒体@file_abc:12:30] 以及 [媒体@file_def:1:00:00]')).toEqual(['file_abc', 750]);
  expect(firstMediaCitation('[媒体@:12:30]')).toBeNull();
  expect(containsMediaAnchor('普通文本 [12:30]')).toBe(false);
});
it('finds_citation_seconds_for_one_resource', () => {
  const text = '见 [媒体@file_abc:12:30] 与 [媒体@file_def:99:99] [媒体@file_def:1:00:00]';
  expect(mediaCitationSecondsFor(text, 'file_def')).toBe(3600);
  expect(mediaCitationSecondsFor(text, 'file_abc')).toBe(750);
  expect(mediaCitationSecondsFor(text, 'file_ab')).toBeNull();
});
it('non_transcript_text_is_left_alone', () => {
  expect(chunkTranscriptForGeneration('file_x', '第一段\n\n第二段')).toBeNull();
  expect(chunkTranscriptForGeneration('file_x', '[00:01] 只有一行\n普通')).toBeNull();
});
it('chunks_by_600_seconds_with_anchor_and_recap', () => {
  const text = transcript([[0, '开场'], [120, '定义 A'], [300, '定义 B'], [550, '例题一'], [590, '例题二'], [610, '第二节开始'], [900, '公式 C'], [1250, '第三节']]);
  const out = chunkTranscriptForGeneration('file_x', text)!;
  expect(out).toContain('## 片段 1/3 · [媒体@file_x:00:00] 起');
  expect(out).toContain('## 片段 2/3 · [媒体@file_x:10:10] 起');
  expect(out).toContain('## 片段 3/3 · [媒体@file_x:20:50] 起');
  expect(out.split('\n\n')).toHaveLength(3);
  const second = out.split('\n\n')[1]!;
  expect(second).toContain('> [05:00] 定义 B');
  expect(second).toContain('> [09:50] 例题二');
  expect(second).not.toContain('> [02:00] 定义 A');
  expect(out.split('\n\n')[0]).not.toContain('上文回顾');
  expect(containsMediaAnchor(out)).toBe(true);
});
it('continuation_lines_stay_in_current_chunk', () => {
  const out = chunkTranscriptForGeneration('file_y', '[00:00] 甲\n续行\n[00:10] 乙\n[00:20] 丙')!;
  expect(out).toContain('[00:00] 甲\n续行\n[00:10] 乙');
  expect(out.match(/## 片段/g)).toHaveLength(1);
});
it('media_detection_reads_files_type_and_mime', () => {
  const f = storageFixture(); fixtures.push(f);
  f.db.exec(`CREATE TABLE files (id TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'document', mime_type TEXT, file_name TEXT NOT NULL);
    INSERT INTO files VALUES ('file_a', 'audio', 'audio/mpeg', '第1讲.mp3');
    INSERT INTO files VALUES ('file_v', 'document', 'video/mp4', '第2讲.mp4');
    INSERT INTO files VALUES ('file_d', 'document', 'application/pdf', '讲义.pdf');`);
  expect(mediaFileName(f.db, 'file_a')).toBe('第1讲.mp3');
  expect(mediaFileName(f.db, 'file_v')).toBe('第2讲.mp4');
  expect(mediaFileName(f.db, 'file_d')).toBeNull();
  expect(mediaFileName(f.db, 'file_missing')).toBeNull();
  const text = transcript([[0, '一'], [5, '二'], [9, '三']]);
  expect(prepareMediaTextForGeneration(f.db, 'file_a', text)).toMatch(/^## 片段 1\/1 · \[媒体@file_a:00:00\] 起/);
  expect(prepareMediaTextForGeneration(f.db, 'file_d', text)).toBe(text);
});
