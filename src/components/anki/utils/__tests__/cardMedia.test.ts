import { describe, expect, it } from 'vitest';
import {
  injectCardMedia,
  isInteractiveCardHtml,
  looksLikeHtml,
  mediaBasename,
  soundNames,
} from '../cardMedia';

const media = new Map([
  ['map.png', 'data:image/png;base64,AAAA'],
  ['clip.mp3', 'data:audio/mpeg;base64,BBBB'],
]);

describe('card media injection', () => {
  it('rewrites local image references to data URLs and leaves remote ones alone', () => {
    const html = '<img src="map.png"> <img src=\'https://x.test/a.png\'> <img src="missing.png">';
    expect(injectCardMedia(html, media)).toBe(
      '<img src="data:image/png;base64,AAAA"> <img src=\'https://x.test/a.png\'> <img src="missing.png">',
    );
  });

  it('turns sound tags into playable audio and falls back to a badge without the file', () => {
    const out = injectCardMedia('Hello [sound:clip.mp3] [sound:gone.mp3]', media, {
      noAutoplay: new Set(['clip.mp3']),
    });
    expect(out).toContain('<audio class="anki-audio" controls preload="auto" src="data:audio/mpeg;base64,BBBB"');
    expect(out).toContain('data-autoplay="0"');
    expect(out).toContain('data-sound-file="gone.mp3"');
    expect(out).not.toContain('[sound:');
  });

  it('collects referenced sound names and file basenames', () => {
    expect([...soundNames('[sound:a.mp3] x [sound:b%20c.mp3]')]).toEqual(['a.mp3', 'b c.mp3']);
    expect(mediaBasename('/data/anki_media/map.png')).toBe('map.png');
    expect(mediaBasename('C:\\data\\anki_media\\map.png')).toBe('map.png');
  });

  it('detects HTML fields and interactive card faces', () => {
    expect(looksLikeHtml('plain text')).toBe(false);
    expect(looksLikeHtml('a <b>bold</b> word')).toBe(true);
    expect(looksLikeHtml('[sound:a.mp3]')).toBe(true);
    expect(looksLikeHtml('[sound:a.mp3]')).toBe(true);
    expect(looksLikeHtml('1 < 2 and 3 > 2')).toBe(false);
    expect(isInteractiveCardHtml('<details><summary>Hint</summary>x</details>')).toBe(true);
    expect(isInteractiveCardHtml('<audio controls></audio>')).toBe(true);
    expect(isInteractiveCardHtml('<div onclick="reveal()">x</div>')).toBe(true);
    expect(isInteractiveCardHtml('<b>static</b><img src="a.png">')).toBe(false);
  });
});
