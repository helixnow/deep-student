/**
 * OverlayScrollbars 样式表里 `[data-overlayscrollbars-viewport~=noContent]… > *…` 让视口属性的每次改写都整片
 * 重算视口子树（见 src/lib/scroll-overlay-stylesheet.ts）。ScrollArea 初始化前把这条规则的子元素分支拆掉；
 * 遇到 RTL 视口（库只在这时设 noContent）时在量测前原样补回。
 */
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import {
  detachOverlayNoContentChildRule,
  restoreOverlayNoContentChildRule,
  withoutNoContentChildBranch,
} from '@/lib/scroll-overlay-stylesheet';

const { hookParams } = vi.hoisted(() => ({ hookParams: [] as Array<{ options?: unknown }> }));

vi.mock('overlayscrollbars-react', () => ({
  useOverlayScrollbars: (params: { options?: unknown }) => {
    hookParams.push(params);
    return [() => {}, () => null];
  },
}));

import { ScrollArea } from '../scroll-area';

const LIBRARY_CSS = fs.readFileSync(
  path.join(process.cwd(), 'node_modules/overlayscrollbars/styles/overlayscrollbars.css'),
  'utf8',
);

const noContentRules = (doc: Document) =>
  Array.from(doc.styleSheets)
    .flatMap((sheet) => Array.from(sheet.cssRules))
    .map((rule) => (rule as CSSStyleRule).selectorText)
    .filter((selector) => typeof selector === 'string' && selector.includes('noContent'));

const hasChildBranch = (doc: Document) => noContentRules(doc).some((selector) => withoutNoContentChildBranch(selector) !== null);

const frames: HTMLIFrameElement[] = [];
afterAll(() => frames.forEach((frame) => frame.remove()));

/** jsdom 只给有浏览上下文的文档解析样式表，每个用例用一个独立 iframe 文档。 */
function documentWithLibraryCss(): Document {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  frames.push(frame);
  const doc = frame.contentDocument!;
  const style = doc.createElement('style');
  style.textContent = LIBRARY_CSS;
  doc.head.appendChild(style);
  return doc;
}

describe('OverlayScrollbars noContent 子元素规则', () => {
  it('当前安装的库样式表里有这条规则', () => {
    expect(hasChildBranch(documentWithLibraryCss())).toBe(true);
  });

  it('拆掉子元素分支，保留 ::before / ::after；RTL 时原样补回', () => {
    const doc = documentWithLibraryCss();
    const before = noContentRules(doc);

    detachOverlayNoContentChildRule(doc);
    expect(hasChildBranch(doc)).toBe(false);
    const detached = noContentRules(doc).find((selector) => selector.includes('::before'));
    expect(detached).toContain('::after');

    restoreOverlayNoContentChildRule(doc);
    expect(noContentRules(doc)).toEqual(before);

    detachOverlayNoContentChildRule(doc);
    expect(hasChildBranch(doc)).toBe(true);
  });

  it('只拆 noContent 视口的子元素分支', () => {
    expect(withoutNoContentChildBranch('[data-overlayscrollbars-viewport~="arrange"]::before')).toBeNull();
    expect(withoutNoContentChildBranch('[data-overlayscrollbars-viewport~="noContent"]:not(#osFakeId)')).toBeNull();
    expect(withoutNoContentChildBranch('.a, [data-overlayscrollbars-viewport~="noContent"] > :not(#x)')).toBe('.a');
  });
});

describe('ScrollArea 接线', () => {
  const style = document.createElement('style');
  style.textContent = LIBRARY_CSS;
  document.head.appendChild(style);
  afterAll(() => style.remove());

  it('初始化 OverlayScrollbars 前拆掉子元素分支', () => {
    expect(hasChildBranch(document)).toBe(true);
    render(<ScrollArea nativeScrollbars={false}>a</ScrollArea>);
    expect(hasChildBranch(document)).toBe(false);
  });

  it('flowDirectionStyles：LTR 返回空且不补回；RTL 先补回规则再返回方向', () => {
    const options = hookParams[hookParams.length - 1]!.options as {
      update: { flowDirectionStyles: (viewport: HTMLElement) => Record<string, string> };
    };
    const ltr = document.createElement('div');
    document.body.appendChild(ltr);
    expect(options.update.flowDirectionStyles(ltr)).toEqual({});
    expect(hasChildBranch(document)).toBe(false);

    const rtl = document.createElement('div');
    rtl.style.direction = 'rtl';
    document.body.appendChild(rtl);
    expect(options.update.flowDirectionStyles(rtl)).toEqual({ direction: 'rtl' });
    expect(hasChildBranch(document)).toBe(true);
  });
});
