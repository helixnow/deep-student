import { describe, expect, it } from 'vitest';
import { buildFileAccept, MARKDOWN_FILE_ACCEPT_MIME } from '../fileAccept';

describe('buildFileAccept', () => {
  it('always puts a MIME type first so wry never replaces intent.type with an empty list', () => {
    const accept = buildFileAccept(MARKDOWN_FILE_ACCEPT_MIME, ['md'], { android: false });
    expect(accept).toBe('text/markdown,text/x-markdown,text/plain,.md');
    expect(accept.startsWith('.')).toBe(false);
  });

  it('adds the Android-only fallback MIME types before the extensions', () => {
    expect(
      buildFileAccept(['application/json'], ['.json'], {
        android: true,
        androidExtraMimeTypes: ['application/octet-stream'],
      }),
    ).toBe('application/json,application/octet-stream,.json');
  });

  it('keeps desktop filtering exact', () => {
    expect(
      buildFileAccept(['application/json'], ['.json'], {
        android: false,
        androidExtraMimeTypes: ['application/octet-stream'],
      }),
    ).toBe('application/json,.json');
  });

  it('rejects extension-only lists', () => {
    expect(() => buildFileAccept([], ['.md'])).toThrow();
  });
});
