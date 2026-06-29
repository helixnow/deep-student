import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('MarkdownEditorWindowSettings source contracts', () => {
  it('is imported and rendered from the General settings tab', () => {
    const source = read('src/features/settings/components/GeneralTab.tsx');

    expect(source).toContain("import { MarkdownEditorWindowSettings } from './MarkdownEditorWindowSettings'");
    expect(source).toContain('<MarkdownEditorWindowSettings />');
  });

  it('uses the shared setting helpers and exact UI copy without live remount events', () => {
    const source = read('src/features/settings/components/MarkdownEditorWindowSettings.tsx');

    expect(source).toContain('notes.editor.initial_line_window');
    expect(source).toContain('loadInitialLineWindowSetting');
    expect(source).toContain('saveInitialLineWindowSetting');
    expect(source).toContain('clampInitialLineWindow');
    expect(source).toContain('Reset initial line window');
    expect(source).toContain('Larger notes start with a smaller window and extend as you scroll.');
    expect(source).not.toMatch(/localStorage|systemSettingsChanged|notes:external-updated|notes:request-save/);
  });

  it('contains exact English locale strings and matching Chinese key path', () => {
    const en = read('src/locales/en-US/settings.json');
    const zh = read('src/locales/zh-CN/settings.json');

    expect(en).toContain('"notes_editor"');
    expect(en).toContain('"initial_line_window"');
    expect(en).toContain('"Initial line window"');
    expect(en).toContain('"Reset initial line window"');
    expect(en).toContain('"Larger notes start with a smaller window and extend as you scroll."');

    expect(zh).toContain('"notes_editor"');
    expect(zh).toContain('"initial_line_window"');
    expect(zh).toContain('"reset"');
    expect(zh).toContain('"desc"');
  });
});
