import { describe, expect, it } from 'vitest';
import { INK_EXTENSION, INK_MIME } from '@/features/ink/types';
import { inferFilePreviewTypeFromName, normalizePreviewType } from '../../../types';
import { resolveFilePreviewMode, type FilePreviewMode } from '../filePreviewResolver';

const inkMode: FilePreviewMode = 'ink';

describe('ink file preview routing', () => {
  it('prefers the dedicated ink MIME over stale text preview metadata', () => {
    expect(resolveFilePreviewMode(INK_MIME, 'notes.json', 'text')).toBe(inkMode);
  });

  it('recognizes the ink extension over generic JSON MIME and stale text preview metadata', () => {
    expect(resolveFilePreviewMode('application/json', `notes.${INK_EXTENSION}`, 'text')).toBe(inkMode);
  });

  it('infers and normalizes ink preview type values', () => {
    expect(inferFilePreviewTypeFromName(`notes.${INK_EXTENSION.toUpperCase()}`)).toBe(inkMode);
    expect(normalizePreviewType('ink')).toBe(inkMode);
  });
});
