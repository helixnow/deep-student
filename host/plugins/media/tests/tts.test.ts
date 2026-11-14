import { expect, it } from 'vitest';
import { speak, ttsArgs } from '../src/tts.ts';

it('preserves TTS platform voice selection, optional rate and ignored volume', () => {
  expect(ttsArgs('darwin', '你好', 'zh-CN', 1)).toEqual(['-v', 'Ting-Ting', '-r', '175', '--', '你好']);
  expect(ttsArgs('darwin', 'a', 'ja', 0.5)).toEqual(['-v', 'Kyoko', '-r', '87', '--', 'a']);
  expect(ttsArgs('darwin', 'a', 'unknown', -1)).toEqual(['-v', 'Alex', '-r', '0', '--', 'a']);
  expect(ttsArgs('linux', 'a', 'ja-JP', 2)).toEqual(['-v', 'ja', '-s', '350', '--', 'a']);
  expect(ttsArgs('linux', 'a', 'unknown', null)).toEqual(['-v', 'en', '--', 'a']);
  expect(ttsArgs('darwin', 'a', null, null)).toEqual(['--', 'a']);
});

it('RF-W04-tts-text-option-injection: speech text that starts with a dash is never parsed as an option', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    expect(ttsArgs(platform, '-o/tmp/x.aiff', null, null)).toEqual(['--', '-o/tmp/x.aiff']);
    expect(ttsArgs(platform, '-w/tmp/x.wav 内容', 'zh', 1).slice(-2)).toEqual(['--', '-w/tmp/x.wav 内容']);
  }
});

it('preserves the existing Windows and unsupported-platform errors', async () => {
  await expect(speak('x', null, null, 'win32')).rejects.toMatchObject({ value: {
    error_type: 'Unknown', message: 'Windows TTS 需要额外配置，请使用 Web Speech API', details: null,
  } });
  await expect(speak('x', null, null, 'aix')).rejects.toMatchObject({ value: {
    error_type: 'Unknown', message: '当前平台不支持 TTS', details: null,
  } });
});
