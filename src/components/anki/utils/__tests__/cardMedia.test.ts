import { describe, expect, it } from 'vitest';
import {
  CARD_FACE_HELPER_SCRIPT,
  extractInlineMediaNames,
  injectCardMedia,
  isAnkiMediaRef,
  isInteractiveCardHtml,
  looksLikeHtml,
  lookupCardMedia,
  mediaBasename,
  soundNames,
  TRANSPARENT_PIXEL_DATA_URL,
} from '../cardMedia';

const media = new Map([
  ['map.png', 'data:image/png;base64,AAAA'],
  ['clip.mp3', 'data:audio/mpeg;base64,BBBB'],
]);

describe('card media injection', () => {
  it('rewrites local image references to data URLs, preserves https, and replaces unresolved local images with CSP-safe placeholders', () => {
    const html = '<img src="map.png"> <img src=\'https://x.test/a.png\'> <img src="missing.png">';
    const out = injectCardMedia(html, media);
    expect(out).toBe(
      `<img src="data:image/png;base64,AAAA"> <img src='https://x.test/a.png'> <img src="${TRANSPARENT_PIXEL_DATA_URL}" data-anki-media-pending="1" data-anki-media-ref="missing.png">`,
    );
    expect(out).not.toContain('src="missing.png"');
  });

  it('rewrites unquoted src, anki-media:// refs, and case-insensitive filenames', () => {
    const html = '<img src=MAP.PNG> <img src="anki-media://map.png"> [sound:CLIP.MP3]';
    const out = injectCardMedia(html, media);
    expect(out).toContain('<img src="data:image/png;base64,AAAA">');
    expect(out).not.toContain('anki-media://');
    expect(out).toContain('<button type="button" class="anki-sound-play"');
    expect(out).toContain('<audio class="anki-audio" controls preload="auto" src="data:audio/mpeg;base64,BBBB"');
  });

  it('extracts inline local media filenames and classifies anki media references', () => {
    expect(
      extractInlineMediaNames('<img src="qa_img_01.png"><img src=qa_img_02.jpg><img src="https://x/a.png">[sound:qa_audio_01.mp3]'),
    ).toEqual(['qa_img_01.png', 'qa_img_02.jpg', 'qa_audio_01.mp3']);
    expect(isAnkiMediaRef('/custom/data/anki_media/qa_img_01.png')).toBe(true);
    expect(isAnkiMediaRef('anki-media://qa_img_01.png')).toBe(true);
    expect(isAnkiMediaRef('qa_img_01.png')).toBe(true);
    expect(isAnkiMediaRef('https://example.com/a.png')).toBe(false);
    expect(lookupCardMedia(media, 'anki-media://MAP.PNG')).toBe('data:image/png;base64,AAAA');
  });

  it('turns sound tags into clickable play controls with playable audio, loading button while pending, and clickable fallback button', () => {
    const out = injectCardMedia('Hello [sound:clip.mp3] [sound:gone.mp3]', media, {
      noAutoplay: new Set(['clip.mp3']),
    });
    expect(out).toContain('<span class="anki-sound-player" data-sound-file="clip.mp3">');
    expect(out).toContain('<button type="button" class="anki-sound-play" data-sound-file="clip.mp3" data-sound-state="ready"');
    expect(out).toContain('<audio class="anki-audio" controls preload="auto" src="data:audio/mpeg;base64,BBBB"');
    expect(out).toContain('data-autoplay="0"');
    expect(out).toContain('<button type="button" class="anki-sound anki-sound-btn" data-sound-file="gone.mp3" data-sound-state="unavailable"');
    expect(out).not.toContain('<span class="anki-sound"');
    expect(out).not.toContain('[sound:');

    const loadingOut = injectCardMedia('Listen [sound:pending.mp3]', new Map(), { mediaLoading: true });
    expect(loadingOut).toContain('<button type="button" class="anki-sound anki-sound-btn" data-sound-file="pending.mp3" data-sound-state="loading" aria-busy="true"');
    expect(isInteractiveCardHtml(loadingOut)).toBe(true);
  });

  it('collects referenced sound names and file basenames', () => {
    expect([...soundNames('[sound:a.mp3] x [sound:b%20c.mp3]')]).toEqual(['a.mp3', 'b c.mp3']);
    expect(mediaBasename('/data/anki_media/map.png')).toBe('map.png');
    expect(mediaBasename('C:\\data\\anki_media\\map.png')).toBe('map.png');
  });

  it('detects HTML fields and interactive card faces including zoomable images', () => {
    expect(looksLikeHtml('plain text')).toBe(false);
    expect(looksLikeHtml('a <b>bold</b> word')).toBe(true);
    expect(looksLikeHtml('[sound:a.mp3]')).toBe(true);
    expect(looksLikeHtml('1 < 2 and 3 > 2')).toBe(false);
    expect(isInteractiveCardHtml('<details><summary>Hint</summary>x</details>')).toBe(true);
    expect(isInteractiveCardHtml('<audio controls></audio>')).toBe(true);
    expect(isInteractiveCardHtml('<div onclick="reveal()">x</div>')).toBe(true);
    expect(isInteractiveCardHtml('<b>static</b><img src="data:image/png;base64,AAAA">')).toBe(true);
    expect(isInteractiveCardHtml('<b>static</b><span>text</span>')).toBe(false);
  });

  it('bridges image zoom clicks (skipping pending placeholders) and sound play buttons in CARD_FACE_HELPER_SCRIPT', () => {
    expect(CARD_FACE_HELPER_SCRIPT).toContain("type: 'sdp-image-click'");
    expect(CARD_FACE_HELPER_SCRIPT).toContain("data-anki-media-pending");
    expect(CARD_FACE_HELPER_SCRIPT).toContain("button.anki-sound-play");
    expect(CARD_FACE_HELPER_SCRIPT).toContain("type: 'sdp-sound-click'");
  });
});
