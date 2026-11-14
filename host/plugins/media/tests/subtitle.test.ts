import { expect, it } from 'vitest';
import type { MediaSegmentRow } from '../api.ts';
import {
  decodeText, exportSegments, parseCueTime, parseExportFormat, parseSubtitle,
} from '../src/subtitle.ts';

function seg(idx: number, start: number, end: number, text: string): MediaSegmentRow {
  return { idx, start_ms: start, end_ms: end, text, status: 1, source: 'asr', plan_version: 1 };
}

it('cue_time_variants', () => {
  expect(parseCueTime('00:00:01,500')).toBe(1_500);
  expect(parseCueTime('01:02:03.004')).toBe(3_723_004);
  expect(parseCueTime('02:03.4')).toBe(123_400);
  expect(parseCueTime('bad')).toBeNull();
});

it('parses_srt_with_markup_and_crlf', () => {
  const srt = '1\r\n00:00:01,000 --> 00:00:03,500\r\n<i>你好</i>\r\n世界\r\n\r\n2\r\n00:00:04,000 --> 00:00:06,000\r\n{\\an8}第二句\r\n\r\n3\r\n00:00:07,000 --> 00:00:08,000\r\n\r\n';
  const cues = parseSubtitle('a.srt', Buffer.from(srt, 'utf8'));
  expect(cues.length).toBe(2);
  expect(cues[0]![0]).toEqual({ start_ms: 1000, end_ms: 3500 });
  expect(cues[0]![1]).toBe('你好 世界');
  expect(cues[1]![1]).toBe('第二句');
});

it('parses_vtt_with_settings_notes_and_voice_tags', () => {
  const vtt = 'WEBVTT - lecture\n\nNOTE this is a comment\nspanning lines\n\nSTYLE\n::cue { color: red }\n\nintro\n00:01.000 --> 00:03.000 align:start position:10%\n<v 老师>今天讲<c.hl>傅里叶</c></v>\n\n00:00:04.250 --> 00:00:05.000\nA &amp; B <00:00:04.500>next\n';
  const cues = parseSubtitle('x.vtt', Buffer.from(vtt, 'utf8'));
  expect(cues.length).toBe(2);
  expect(cues[0]![0]).toEqual({ start_ms: 1000, end_ms: 3000 });
  expect(cues[0]![1]).toBe('今天讲傅里叶');
  expect(cues[1]![0].start_ms).toBe(4250);
  expect(cues[1]![1]).toBe('A & B next');
});

it('parses_bilibili_bcc_json', () => {
  const bcc = '{"font_size":0.4,"body":[{"from":2.5,"to":4.0,"location":2,"content":"第二条"},{"from":0.0,"to":2.1,"location":2,"content":"第一条\\n换行"}]}';
  const cues = parseSubtitle('sub.json', Buffer.from(bcc, 'utf8'));
  expect(cues.length).toBe(2);
  expect(cues[0]![1]).toBe('第一条 换行');
  expect(cues[0]![0]).toEqual({ start_ms: 0, end_ms: 2100 });
  expect(cues[1]![0].start_ms).toBe(2500);
});

it('decodes_gbk_and_rejects_garbage', () => {
  const head = Buffer.from('1\n00:00:01,000 --> 00:00:02,000\n', 'ascii');
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xd7, 0xd6, 0xc4, 0xbb, 0x0a]);
  const cues = parseSubtitle('gbk.srt', Buffer.concat([head, gbk]));
  expect(cues[0]![1]).toBe('中文字幕');
  expect(() => parseSubtitle('x.txt', Buffer.from('hello world'))).toThrow();
  expect(() => parseSubtitle('x.json', Buffer.from('{"nope":1}'))).toThrow();
  expect(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x41]))).toBe('A');
});

it('export_roundtrips_through_parsers', () => {
  const segs = [seg(0, 1_000, 2_500, '第一句'), seg(1, 3_000, 3_725_004, '跨 --> 小时'),
    { ...seg(2, 4_000, 5_000, 'pending'), status: 0 }];
  const srt = exportSegments(segs, 'srt');
  expect(srt.startsWith('1\n00:00:01,000 --> 00:00:02,500\n第一句\n\n2\n')).toBe(true);
  const back = parseSubtitle('e.srt', Buffer.from(srt, 'utf8'));
  expect(back.length).toBe(2);
  expect(back[1]![0].end_ms).toBe(3_725_004);
  expect(back[1]![1]).toBe('跨 → 小时');

  const vtt = exportSegments(segs, 'vtt');
  expect(vtt.startsWith('WEBVTT\n\n00:00:01.000 --> 00:00:02.500\n')).toBe(true);
  const backVtt = parseSubtitle('e.vtt', Buffer.from(vtt, 'utf8'));
  expect(backVtt.length).toBe(2);
  expect(backVtt[1]![1]).toBe('跨 → 小时');

  expect(exportSegments(segs, 'txt')).toBe('[00:01] 第一句\n[00:03] 跨 --> 小时\n');
  expect(parseExportFormat('WebVTT')).toBe('vtt');
  expect(() => parseExportFormat('docx')).toThrow();
});
