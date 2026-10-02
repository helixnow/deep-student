import { describe, expect, it } from 'vitest';
import { Editor, rootCtx, defaultValueCtx } from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { getMarkdown } from '@milkdown/kit/utils';

import { internalLinkSchema, isInternalLinkHref } from '../internalLinkSchemes';

async function renderHrefs(markdown: string) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
    })
    .use(commonmark)
    .use(internalLinkSchema)
    .create();
  const hrefs = [...root.querySelectorAll('a')].map((a) => a.getAttribute('href'));
  const roundtrip = editor.action(getMarkdown());
  await editor.destroy();
  root.remove();
  return { hrefs, roundtrip };
}

describe('internal link schemes', () => {
  it('keeps pdfref:// source lines and note:// mentions clickable', async () => {
    const md = '[第 1 页](pdfref://file_abc?page=1) 和 [笔记](note://note_x)';
    const { hrefs, roundtrip } = await renderHrefs(md);
    expect(hrefs).toEqual(['pdfref://file_abc?page=1', 'note://note_x']);
    expect(roundtrip).toContain('(pdfref://file_abc?page=1)');
  });

  it('still strips unsafe protocols and keeps web links', async () => {
    const { hrefs } = await renderHrefs('[x](javascript:alert(1)) [y](https://a.b)');
    expect(hrefs).toEqual(['', 'https://a.b']);
  });

  it('recognises only the internal protocols', () => {
    expect(isInternalLinkHref(' PDFREF://x')).toBe(true);
    expect(isInternalLinkHref('notes://x')).toBe(false);
    expect(isInternalLinkHref(null)).toBe(false);
  });
});
