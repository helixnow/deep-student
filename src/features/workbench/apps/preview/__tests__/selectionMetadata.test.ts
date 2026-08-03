import { afterEach, describe, expect, it } from 'vitest';
import { getPreviewHighlightNames, getPreviewSelectionMetadata } from '../FilePreviewAppWindow';

function selectText(node: Text, start = 0, end = node.data.length): void {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

describe('file preview selection metadata', () => {
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = '';
  });

  it('builds an XLSX sheet and cell locator', () => {
    const root = document.createElement('div');
    root.innerHTML = '<table data-xlsx-sheet="Scores"><tbody><tr><td data-xlsx-cell="B3">Alice 98</td></tr></tbody></table>';
    document.body.appendChild(root);
    selectText(root.querySelector('td')!.firstChild as Text);

    expect(getPreviewSelectionMetadata(root)).toEqual({
      selectedText: 'Alice 98',
      locator: 'Scores!B3',
    });
  });

  it('builds a slide locator for PPTX text', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div><div class="pptx-preview-slide-wrapper">One</div><div class="pptx-preview-slide-wrapper">Two</div></div>';
    document.body.appendChild(root);
    selectText(root.querySelectorAll('.pptx-preview-slide-wrapper')[1].firstChild as Text);

    expect(getPreviewSelectionMetadata(root)).toEqual({ selectedText: 'Two', locator: 'slide:2' });
  });

  it('builds a line locator for plain text', () => {
    const root = document.createElement('div');
    const pre = document.createElement('pre');
    const text = document.createTextNode('first\nsecond\nthird');
    pre.appendChild(text);
    root.appendChild(pre);
    document.body.appendChild(root);
    selectText(text, 6, 12);

    expect(getPreviewSelectionMetadata(root)).toEqual({ selectedText: 'second', locator: 'line:2' });
  });
});

describe('file preview highlight identity', () => {
  it('accepts an empty instance key without crashing', () => {
    expect(getPreviewHighlightNames(null)).toEqual({
      all: 'file-preview-search-empty',
      current: 'file-preview-search-current-empty',
    });
  });

  it('normalizes resource paths and unsafe characters', () => {
    expect(getPreviewHighlightNames('/folder/report 1.pdf')).toEqual({
      all: 'file-preview-search-report-1-pdf',
      current: 'file-preview-search-current-report-1-pdf',
    });
  });
});
