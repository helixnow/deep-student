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
    ['standard', '816px', '0.75em'],
    ['compact', '720px', '0.5em'],
    ['wide', '1120px', '0.75em'],
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
    expect(getComputedStyle(shell).getPropertyValue('--notes-content-max-w').trim()).toBe(width);
    expect(getComputedStyle(shell).getPropertyValue('--notes-block-gap').trim()).toBe(gap);
    shell.dataset.focusMode = 'true';
    expect(getComputedStyle(content).maxWidth).toBe(normal);
    expect(normal).toBe('var(--notes-content-max-w, 816px)');
    expect(getComputedStyle(shell).getPropertyValue('--notes-content-max-w').trim()).toBe(width);
    expect(header.isConnected).toBe(true);
  });
});
