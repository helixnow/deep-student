import { describe, expect, it, vi } from 'vitest';

import { attachPreviewFrame, resolvePreviewLink } from '../chatHtmlPreviewFrame';

describe('resolvePreviewLink', () => {
  it('routes absolute http(s)/mailto links to the system browser', () => {
    expect(resolvePreviewLink('https://example.com/a?b=1')).toEqual({ kind: 'external', url: 'https://example.com/a?b=1' });
    expect(resolvePreviewLink(' http://x.test ')).toEqual({ kind: 'external', url: 'http://x.test/' });
    expect(resolvePreviewLink('mailto:a@b.c')).toEqual({ kind: 'external', url: 'mailto:a@b.c' });
  });

  it('scrolls to in-page anchors', () => {
    expect(resolvePreviewLink('#sec-2')).toEqual({ kind: 'anchor', id: 'sec-2' });
    expect(resolvePreviewLink('#%E7%AB%A0')).toEqual({ kind: 'anchor', id: '章' });
  });

  it('ignores everything else', () => {
    for (const href of ['', '#', 'javascript:alert(1)', 'file:///etc/passwd', 'page2.html', '/abs', 'data:text/html,x', 'tauri://localhost']) {
      expect(resolvePreviewLink(href)).toEqual({ kind: 'ignore' });
    }
  });
});

describe('attachPreviewFrame', () => {
  const makeDoc = () => {
    const doc = document.implementation.createHTMLDocument('preview');
    doc.body.innerHTML = '<p id="sec">target</p><a id="ext" href="https://example.com"><span id="inner">ext</span></a>'
      + '<a id="js" href="javascript:alert(1)">js</a><a id="anchor" href="#sec">jump</a><span id="plain">x</span>';
    return doc;
  };
  const click = (el: Element, type = 'click') => {
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev;
  };

  it('intercepts link clicks: external → handler, never navigates the frame', () => {
    const doc = makeDoc();
    const onExternalLink = vi.fn();
    const cleanup = attachPreviewFrame(doc, { onExternalLink, onContentHeight: vi.fn() });

    const ev = click(doc.getElementById('inner')!);
    expect(ev.defaultPrevented).toBe(true);
    expect(onExternalLink).toHaveBeenCalledWith('https://example.com/');

    const js = click(doc.getElementById('js')!);
    expect(js.defaultPrevented).toBe(true);
    expect(onExternalLink).toHaveBeenCalledTimes(1);

    const middle = click(doc.getElementById('ext')!, 'auxclick');
    expect(middle.defaultPrevented).toBe(true);
    expect(onExternalLink).toHaveBeenCalledTimes(1);

    expect(click(doc.getElementById('plain')!).defaultPrevented).toBe(false);

    cleanup();
    expect(click(doc.getElementById('ext')!).defaultPrevented).toBe(false);
    expect(onExternalLink).toHaveBeenCalledTimes(1);
  });

  it('scrolls anchors inside the frame', () => {
    const doc = makeDoc();
    const target = doc.getElementById('sec')! as HTMLElement & { scrollIntoView: (o?: unknown) => void };
    target.scrollIntoView = vi.fn();
    attachPreviewFrame(doc, { onExternalLink: vi.fn(), onContentHeight: vi.fn() });
    expect(click(doc.getElementById('anchor')!).defaultPrevented).toBe(true);
    expect(target.scrollIntoView).toHaveBeenCalled();
  });
});
