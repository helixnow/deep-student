import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('windowed markdown source contracts', () => {
  it('keeps Learning Hub windowing frontend-only and passes visible content to Crepe', () => {
    const source = read('src/features/learning-hub/apps/views/NoteContentView.tsx');

    const nodeReadIndex = source.indexOf('const nodeResult = await dstu.get(path)');
    const contentReadIndex = source.indexOf('const contentResult = await dstu.getContent(path)');
    expect(source).toContain('readOccSafeNoteSnapshot');
    expect(nodeReadIndex).toBeGreaterThanOrEqual(0);
    expect(contentReadIndex).toBeGreaterThan(nodeReadIndex);
    expect(source).not.toMatch(/getContentRange|get_content_range|streamContent|rangeStart|rangeEnd/);
    expect(source).toContain('initialContent={visibleContent}');
    expect(source).toContain('composeWindowedSave');
    expect(source).toContain('expandMarkdownWindow');
    expect(source).toContain('loadInitialLineWindowSetting');
  });

  it('keeps editor expansion guarded and DSTU identity independent of window state', () => {
    const source = read('src/features/notes/NotesCrepeEditor.tsx');

    expect(source).toContain('programmaticUpdateRef');
    expect(source).toContain('onRequestLoadMore');
    expect(source).toContain('shouldRequestLoadMore');
    expect(source).toContain('loadMoreInFlightRef');

    const keyIndex = source.indexOf('contentVersionKey');
    expect(keyIndex).toBeGreaterThanOrEqual(0);
    const keySegment = source.slice(keyIndex, keyIndex + 350);
    expect(keySegment).not.toMatch(/loadedLineCount|loadedMarkdown|totalLineCount|hasMore/);
  });

  it('keeps Crepe content replacement on replaceAll(markdown)', () => {
    const source = read('src/components/crepe/CrepeEditor.tsx');

    expect(source).toContain('replaceAll(markdown)');
  });

  it('contains exact UI-SPEC copy in English locales', () => {
    const notes = read('src/locales/en-US/notes.json');
    const settings = read('src/locales/en-US/settings.json');

    expect(notes).toContain('Loading note...');
    expect(notes).toContain('Loading more lines...');
    expect(notes).toContain('Could not load more lines. Retry loading more lines.');
    expect(settings).toContain('Reset initial line window');
    expect(settings).toContain('Larger notes start with a smaller window and extend as you scroll.');
  });
});
