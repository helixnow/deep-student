import { describe, expect, it } from 'vitest';
import {
  parsePersistedTileMargins,
  parsePersistedWallpaper,
} from '@/features/workbench/core/persistedSettings';

const wallpaperFallback = { kind: 'theme' as const, value: 'mountain-mist' };
const marginFallback = { enabled: true, px: 8 };

describe('workbench persisted setting compatibility', () => {
  it('accepts valid v0.9.44 JSON without changing user choices', () => {
    expect(parsePersistedWallpaper(
      JSON.stringify({ kind: 'theme', value: 'nebula' }),
      wallpaperFallback,
    )).toEqual({ kind: 'theme', value: 'nebula' });
    expect(parsePersistedTileMargins(
      JSON.stringify({ enabled: false, px: 16 }),
      marginFallback,
    )).toEqual({ enabled: false, px: 16 });
  });

  it('rejects malformed wallpaper shapes before WallpaperLayer string operations', () => {
    for (const value of [
      'not-json',
      '[]',
      JSON.stringify({ kind: 'image', value: 123 }),
      JSON.stringify({ kind: 'unknown', value: '/tmp/wallpaper.png' }),
    ]) {
      expect(parsePersistedWallpaper(value, wallpaperFallback)).toEqual(wallpaperFallback);
    }
  });

  it('sanitizes optional image adaptation fields independently', () => {
    expect(parsePersistedWallpaper({
      kind: 'image',
      value: '/tmp/wallpaper.png',
      imageBlur: 500,
      imageDim: -2,
      imageVignette: false,
      injected: 'ignored',
    }, wallpaperFallback)).toEqual({
      kind: 'image',
      value: '/tmp/wallpaper.png',
      imageBlur: 40,
      imageDim: 0,
      imageVignette: false,
    });
  });

  it('keeps valid margin fields while defaulting or clamping invalid fields', () => {
    expect(parsePersistedTileMargins(
      JSON.stringify({ enabled: false, px: 'wide' }),
      marginFallback,
    )).toEqual({ enabled: false, px: 8 });
    expect(parsePersistedTileMargins(
      { enabled: 'yes', px: 999 },
      marginFallback,
    )).toEqual({ enabled: true, px: 32 });
    expect(parsePersistedTileMargins([], marginFallback)).toEqual(marginFallback);
  });
});
