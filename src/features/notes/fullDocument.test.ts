import { describe, expect, it, vi } from 'vitest';
import type { CrepeEditorApi } from '@/components/crepe';
import i18n from '@/i18n';
import { assertNoteContentSize, createFullDocumentApi, MAX_NOTE_CONTENT_BYTES } from './fullDocument';
import { composeWindowedSave, mergeExpandedMarkdown } from './markdownWindow';

describe('full document host service', () => {
  function fixture() {
    const state = { visible: 'UNSAVED\r\n', backing: 'saved\r\n\r\nunloaded\r\n\r\n', current: true, revision: 1 };
    const retainFailure = vi.fn();
    const replace = vi.fn(async (markdown: string) => { state.visible = markdown; state.backing = markdown; return true; });
    const api = createFullDocumentApi({
      getMarkdown: () => state.visible,
      getFullMarkdown: () => composeWindowedSave(state.visible, state.backing, 2, true),
      replaceFullMarkdown: replace,
      isReadonly: () => false,
    } as unknown as CrepeEditorApi, {
      noteId: 'n1', isCurrent: () => state.current, revision: () => state.revision,
      isWindowed: () => true, retainFailure,
    });
    return { api, state, replace, retainFailure };
  }

  it('reads unsaved window plus untouched tail, retaining boundary and final blank lines', () => {
    const { api } = fixture();
    expect(api.getFullDocument()).toEqual({ noteId: 'n1', revision: 1, markdown: 'UNSAVED\r\n\nunloaded\r\n\r\n' });
    expect(composeWindowedSave('', '\ntail\n', 1, true)).toBe('\ntail\n');
    expect(composeWindowedSave('', 'tail\n', 0, true)).toBe('tail\n');
  });

  it('merges edits made during load-more without overwriting them or dropping appended lines', () => {
    expect(mergeExpandedMarkdown('prefix\n', 'edited\n\n', 'prefix\n\ntail\n')).toBe('edited\n\n\ntail\n');
    expect(() => mergeExpandedMarkdown('prefix', 'edited', 'unrelated')).toThrow();
  });

  it('rejects a stale revision even when text changed back to the same value', async () => {
    const { api, state, replace } = fixture();
    const baseline = api.getFullDocument();
    state.revision++;
    await expect(api.replaceFullDocument('AI', baseline)).rejects.toThrow('笔记已变化');
    expect(replace).not.toHaveBeenCalled();
  });

  it('rejects a different note and a detached editor before invoking storage', async () => {
    const { api, state, replace } = fixture();
    const baseline = api.getFullDocument();
    await expect(api.replaceFullDocument('AI', { ...baseline, noteId: 'n2' })).rejects.toThrow();
    state.current = false;
    await expect(api.replaceFullDocument('AI', baseline)).rejects.toThrow('过期编辑器');
    expect(replace).not.toHaveBeenCalled();
  });

  it('counts UTF-8 bytes exactly and retains oversized input without truncation', async () => {
    const { api, replace, retainFailure } = fixture();
    expect(() => assertNoteContentSize('a'.repeat(MAX_NOTE_CONTENT_BYTES))).not.toThrow();
    expect(() => assertNoteContentSize('🙂'.repeat(MAX_NOTE_CONTENT_BYTES / 4))).not.toThrow();
    expect(() => assertNoteContentSize('🙂'.repeat(MAX_NOTE_CONTENT_BYTES / 4) + 'a')).toThrow('UTF-8');
    const oversized = '中'.repeat(350000);
    expect(oversized.length).toBeLessThan(MAX_NOTE_CONTENT_BYTES);
    await expect(api.replaceFullDocument(oversized, api.getFullDocument())).rejects.toThrow('UTF-8');
    expect(replace).not.toHaveBeenCalled();
    expect(retainFailure.mock.calls[0][0]).toBe(oversized);
  });

  it('retains an entire candidate on storage failure; does not auto-restore over a concurrent edit', async () => {
    const { api, replace, retainFailure } = fixture();
    const original = api.getFullDocument();
    replace.mockRejectedValueOnce(new Error('conflict'));
    await expect(api.replaceFullDocument('candidate\n\n', original)).rejects.toThrow('conflict');
    expect(retainFailure.mock.calls[0][0]).toBe('candidate\n\n');
    expect(retainFailure.mock.calls[0][2]).toBe(original.markdown);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('localizes helper errors in English while keeping rejected content and the baseline intact', async () => {
    await vi.waitFor(() => expect(i18n.hasResourceBundle('en-US', 'notes')).toBe(true));
    const language = i18n.language;
    await i18n.changeLanguage('en-US');
    try {
      const { api, state, replace, retainFailure } = fixture();
      const baseline = api.getFullDocument();
      state.revision++;
      await expect(api.replaceFullDocument('保留候选 {{title}}', baseline)).rejects.toThrow(
        'The note changed or you switched notes',
      );
      expect(replace).not.toHaveBeenCalled();
      expect(retainFailure.mock.calls[0][0]).toBe('保留候选 {{title}}');
      expect(retainFailure.mock.calls[0][2]).toBe(baseline.markdown);
      expect(() => mergeExpandedMarkdown('prefix', 'edited', 'unrelated')).toThrow(
        'The previously loaded content has changed',
      );
    } finally {
      await i18n.changeLanguage(language);
    }
  });
});
