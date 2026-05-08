import { describe, expect, it } from 'vitest';

import {
  DEFAULT_VOICE_INPUT_CONFIG,
  normalizeVoiceInputConfig,
} from '../config';

describe('voice input config defaults', () => {
  it('stores behavior defaults without persisting provider or model selection', () => {
    expect(DEFAULT_VOICE_INPUT_CONFIG.maxDurationMs).toBe(60_000);
    expect(DEFAULT_VOICE_INPUT_CONFIG.insertMode).toBe('replace-selection');
    expect(DEFAULT_VOICE_INPUT_CONFIG.hotkey).toBe('mod+shift+space');
  });

  it('falls back to defaults when persisted config is partial or invalid and ignores legacy provider/model fields', () => {
    expect(
      normalizeVoiceInputConfig({
        providerId: 'siliconflow',
        model: 'TeleAI/TeleSpeechASR',
        maxDurationMs: -100,
        insertMode: 'not-valid',
        hotkey: '   ',
      })
    ).toEqual({
      maxDurationMs: 60_000,
      insertMode: 'replace-selection',
      hotkey: 'mod+shift+space',
      language: undefined,
      prompt: undefined,
    });
  });
});
