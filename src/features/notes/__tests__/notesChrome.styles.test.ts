import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Vitest disables CSS imports in this repository. Read the actual stylesheets
// so this test exercises selectors/cascade instead of mocked CSS modules.
const typography = readFileSync(resolve(process.cwd(), 'src/styles/notes-typography.css'), 'utf8');
const chrome = readFileSync(resolve(process.cwd(), 'src/features/notes/styles/notes-editor-chrome.css'), 'utf8');

afterEach(() => document.querySelectorAll('[data-chrome-test]').forEach((element) => element.remove()));

describe('notes preset CSS', () => {
  it.each([
    // 正文宽度（不含 gutter）：标准对齐 Notion 默认页 708px
    ['standard', '708px', '0.4em'],
    ['compact', '620px', '0.35em'],
    ['wide', '1040px', '0.4em'],
  ])('applies %s to the actual shell and keeps that column in focus mode', (preset, width, gap) => {
    const style = document.createElement('style');
    style.dataset.chromeTest = '';
    style.textContent = typography + '\n' + chrome;
    document.head.appendChild(style);
    const shell = document.createElement('section');
    shell.dataset.chromeTest = '';
    shell.className = 'notes-crepe-shell';
    const content = document.createElement('div');
    content.className = 'notes-editor-content';
    const header = document.createElement('header');
    header.className = 'notes-document-header';
    header.dataset.notesPreset = preset;
    content.appendChild(header);
    shell.appendChild(content);
    document.body.appendChild(shell);

    const normal = getComputedStyle(content).maxWidth;
    expect(getComputedStyle(shell).getPropertyValue('--notes-text-w').trim()).toBe(width);
    // 列宽 = 正文宽 + 两侧 gutter（块手柄落在左 gutter）
    expect(getComputedStyle(shell).getPropertyValue('--notes-content-max-w').trim())
      .toBe('calc(var(--notes-text-w) + 2 * var(--notes-gutter))');
    expect(getComputedStyle(shell).getPropertyValue('--notes-block-gap').trim()).toBe(gap);
    shell.dataset.focusMode = 'true';
    expect(getComputedStyle(content).maxWidth).toBe(normal);
    expect(normal).toBe('var(--notes-content-max-w, 816px)');
    expect(getComputedStyle(shell).getPropertyValue('--notes-text-w').trim()).toBe(width);
    expect(header.isConnected).toBe(true);
  });
});
