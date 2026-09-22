import type { MilkdownPlugin } from '@milkdown/ctx';
import { createTimer } from '@milkdown/ctx';
import { ParserReady, parserCtx, editorStateTimerCtx } from '@milkdown/kit/core';
import { normalizeOfficialDiffDoc } from './officialDiffAdapter';

/** Run after the raw Markdown parser, before initial state AND later replaceAll.
 * The same helper is used by full-document preflight and the review projection. */
export const canonicalDocumentPlugin: MilkdownPlugin = ctx => {
  const ready = createTimer('CrepeCanonicalDocument');
  ctx.record(ready).update(editorStateTimerCtx, timers => [...timers, ready]);
  return async () => {
    await ctx.wait(ParserReady);
    const raw = ctx.get(parserCtx);
    ctx.set(parserCtx, markdown => {
      const doc = raw(markdown);
      return doc ? normalizeOfficialDiffDoc(doc) : doc;
    });
    ctx.done(ready);
    return () => { ctx.clearTimer(ready); };
  };
};
