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
    // [开关, --notes-content-max-w, --notes-block-gap, --notes-body-size]：版心对齐 Notion 默认 708px
    ['default', 'calc(var(--notes-text-w) + 2 * var(--notes-gutter))', '0.4em', 'calc(16px * var(--font-size-scale, 1))'],
    ['smallText', 'calc(var(--notes-text-w) + 2 * var(--notes-gutter))', '0.35em', 'calc(14px * var(--font-size-scale, 1))'],
    ['fullWidth', '100%', '0.4em', 'calc(16px * var(--font-size-scale, 1))'],
  ])('applies %s to the actual shell and keeps that column in focus mode', (toggle, maxW, gap, size) => {
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
    if (toggle === 'smallText') header.dataset.notesSmallText = 'true';
    if (toggle === 'fullWidth') header.dataset.notesFullWidth = 'true';
    content.appendChild(header);
    shell.appendChild(content);
    document.body.appendChild(shell);

    const normal = getComputedStyle(content).maxWidth;
    // 小字号只缩字不改版心（Notion 同款）；列宽 = 正文宽 + 两侧 gutter（块手柄落在左 gutter）
    expect(getComputedStyle(shell).getPropertyValue('--notes-text-w').trim()).toBe('708px');
    expect(getComputedStyle(shell).getPropertyValue('--notes-content-max-w').trim()).toBe(maxW);
    expect(getComputedStyle(shell).getPropertyValue('--notes-block-gap').trim()).toBe(gap);
    expect(getComputedStyle(shell).getPropertyValue('--notes-body-size').trim()).toBe(size);
    shell.dataset.focusMode = 'true';
    expect(getComputedStyle(content).maxWidth).toBe(normal);
    expect(normal).toBe('var(--notes-content-max-w, 816px)');
    expect(getComputedStyle(shell).getPropertyValue('--notes-content-max-w').trim()).toBe(maxW);
    expect(header.isConnected).toBe(true);
  });
});
