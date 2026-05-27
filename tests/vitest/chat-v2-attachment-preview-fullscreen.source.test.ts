import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('chat attachment preview fullscreen contract', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/features/chat/pages/ChatV2Page.tsx'),
    'utf-8'
  );

  it('renders desktop attachment previews through a fullscreen branch', () => {
    expect(source).toContain('const desktopAttachmentPreviewFullScreen = !isSmallScreen');
    expect(source).toContain('desktopAttachmentPreviewFullScreen ? (');
    expect(source).toContain('renderOpenAppPanel({ fullScreen: true })');
  });
});
