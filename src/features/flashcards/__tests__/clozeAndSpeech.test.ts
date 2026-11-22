import { describe, expect, it } from 'vitest';
import { insertClozeDeletion, nextClozeIndex } from '../cloze';
import { getReviewCardSpeechText, hasReviewCardAudio } from '../review/cardSpeechText';
import type { ReviewCard } from '../store/fsrsReviewStore';

describe('cloze insertion helpers', () => {
  it('computes next sequential cloze index', () => {
    expect(nextClozeIndex('Plain text')).toBe(1);
    expect(nextClozeIndex('The {{c1::mitochondria}} is the powerhouse.')).toBe(2);
    expect(nextClozeIndex('{{c1::A}} and {{c3::B}}')).toBe(4);
  });

  it('wraps selected text or inserts placeholder with selection range', () => {
    const wrapped = insertClozeDeletion('Earth orbits the Sun', 6, 12);
    expect(wrapped.nextValue).toBe('Earth {{c1::orbits}} the Sun');
    expect(wrapped.nextSelectionStart).toBe(20);
    expect(wrapped.nextSelectionEnd).toBe(20);

    const inserted = insertClozeDeletion('Earth {{c1::orbits}} ', 21, 21, '词');
    expect(inserted.nextValue).toBe('Earth {{c1::orbits}} {{c2::词}}');
    expect(inserted.nextValue.slice(inserted.nextSelectionStart, inserted.nextSelectionEnd)).toBe('词');
  });
});

describe('cardSpeechText helpers', () => {
  it('extracts speakable text for Basic and Cloze cards while stripping sound tags', () => {
    const basic: ReviewCard = {
      id: 's1',
      front: '<b>Photosynthesis</b> [sound:photo.mp3]',
      back: 'Light &rarr; chemical energy',
    };
    expect(getReviewCardSpeechText(basic, false)).toBe('Photosynthesis');
    expect(getReviewCardSpeechText(basic, true)).toBe('Light &rarr; chemical energy');
    expect(hasReviewCardAudio(basic)).toBe(true);

    const cloze: ReviewCard = {
      id: 's2',
      front: '',
      back: 'Biology extra',
      text: 'The {{c1::mitochondria}} produces ATP.',
    };
    expect(getReviewCardSpeechText(cloze, false)).toContain('[...]');
    expect(getReviewCardSpeechText(cloze, true)).toContain('mitochondria');
    expect(getReviewCardSpeechText(cloze, true)).toContain('Biology extra');
    expect(hasReviewCardAudio(cloze)).toBe(false);
  });

  it('detects audio attachments in card.images', () => {
    const card: ReviewCard = {
      id: 's3',
      front: 'Bonjour',
      back: 'Hello',
      images: ['/tmp/anki_media/bonjour.mp3'],
    };
    expect(hasReviewCardAudio(card)).toBe(true);
  });
});
