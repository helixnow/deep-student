import { describe, expect, it } from 'vitest';

import {
  getRenderModeHint,
  getRenderModeLabel,
  getStreamingPresetHint,
  getStreamingPresetLabel,
} from './labels';

describe('getStreamingPresetLabel', () => {
  it('returns Chinese labels for every streaming preset', () => {
    expect(getStreamingPresetLabel('natural')).toBe('自然');
    expect(getStreamingPresetLabel('realtime')).toBe('实时');
    expect(getStreamingPresetLabel('balanced')).toBe('均衡');
    expect(getStreamingPresetLabel('silky')).toBe('丝滑');
    expect(getStreamingPresetLabel('fluid')).toBe('流畅');
  });

  it('returns helpful Chinese hints for every streaming preset', () => {
    expect(getStreamingPresetHint('natural')).toContain('原生速度');
    expect(getStreamingPresetHint('realtime')).toContain('即时反馈');
    expect(getStreamingPresetHint('balanced')).toContain('折中');
    expect(getStreamingPresetHint('silky')).toContain('顺滑');
    expect(getStreamingPresetHint('fluid')).toContain('流动感');
  });
});

describe('render mode labels', () => {
  it('returns Chinese labels and hints for both render modes', () => {
    expect(getRenderModeLabel('legacy')).toBe('整段');
    expect(getRenderModeHint('legacy')).toContain('兼容性最好');
    expect(getRenderModeLabel('blocked')).toBe('块级');
    expect(getRenderModeHint('blocked')).toContain('拆分重渲');
  });
});
