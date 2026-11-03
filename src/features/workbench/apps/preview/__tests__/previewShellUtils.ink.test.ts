import { describe, expect, it } from 'vitest';
import { resolvePreviewShellMode } from '../previewShellUtils';

describe('preview shell ink routing', () => {
  it('shares ink MIME and extension priority over stale text preview metadata', () => {
    expect(resolvePreviewShellMode({
      type: 'file',
      name: 'notes.dsink',
      previewType: 'text',
      metadata: { mimeType: 'application/json' },
    })).toBe('ink');
    expect(resolvePreviewShellMode({
      type: 'file',
      name: 'notes.json',
      previewType: 'text',
      metadata: { mimeType: 'application/vnd.deepstudent.ink+json' },
    })).toBe('ink');
  });
});
