import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('macOS font smoothing contracts', () => {
  it('removes broad grayscale antialiasing from shared component layers and gates the root override through document data', () => {
    const typographySource = readFileSync(resolve(process.cwd(), 'src/styles/typography.css'), 'utf8');
    const componentSources = [
      readFileSync(resolve(process.cwd(), 'src/chat-v2/styles/chat-beautify.css'), 'utf8'),
      readFileSync(resolve(process.cwd(), 'src/components/mindmap/mindmap.css'), 'utf8'),
    ];
    const baseTypographyRule = typographySource.match(/html,\s*body,\s*#root\s*\{[\s\S]*?\n\}/u)?.[0] ?? '';

    expect(typographySource).toContain('html[data-font-smoothing="macos-native"] body');
    expect(typographySource).toContain('html[data-font-smoothing="macos-grayscale"] body');
    expect(baseTypographyRule).not.toContain('-webkit-font-smoothing: antialiased;');

    for (const source of componentSources) {
      expect(source).not.toContain('-webkit-font-smoothing: antialiased;');
      expect(source).not.toContain('-moz-osx-font-smoothing: grayscale;');
    }
  });

  it('legacy app settings load and apply the macOS font smoothing preference through the document dataset', () => {
    const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');

    expect(appSource).toContain('macos.native_font_smoothing');
    expect(appSource).toContain('document.documentElement.dataset.fontSmoothing');
    expect(appSource).toContain('macos-native');
    expect(appSource).toContain('macos-grayscale');
  });
});
