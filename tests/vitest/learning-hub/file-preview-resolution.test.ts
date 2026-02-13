import { describe, expect, it } from 'vitest';

import { resolveFilePreviewMode } from '@/components/learning-hub/apps/views/filePreviewResolver';

describe('file preview resolver', () => {
  it('resolves audio preview by mime type', () => {
    expect(resolveFilePreviewMode('audio/mpeg', 'track.bin')).toBe('audio');
  });

  it('resolves video preview by extension fallback', () => {
    expect(resolveFilePreviewMode('application/octet-stream', 'demo.mov')).toBe('video');
  });

  it('resolves office and text preview types', () => {
    expect(resolveFilePreviewMode('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'doc.docx')).toBe('docx');
    expect(resolveFilePreviewMode('text/plain', 'readme.txt')).toBe('text');
    expect(resolveFilePreviewMode('application/pdf', 'book.pdf')).toBe('pdf');
  });
});
