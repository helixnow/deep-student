import { afterEach, describe, expect, it } from 'vitest';
import { Schema } from '@milkdown/prose/model';

import { handleMediaRefClick, MEDIA_REF_ANCHOR_ATTR, MEDIA_REF_SECONDS_ATTR } from '../click';
import { buildMediaRefHref, findMediaRefMarkers, parseMediaRefHref } from '../protocol';
import { buildMediaRefDecorations } from '..';
import { isInternalLinkHref } from '../../internalLinkSchemes';

describe('mediaref:// protocol', () => {
  it('round-trips resource id and seconds', () => {
    const href = buildMediaRefHref('file_abc', 754.9);
    expect(href).toBe('mediaref://file_abc?t=754');
    expect(parseMediaRefHref(href)).toEqual({ resourceId: 'file_abc', seconds: 754 });
  });

  it('accepts clock-style t and rejects missing / invalid t', () => {
    expect(parseMediaRefHref('mediaref://file_1?t=12:34')).toEqual({ resourceId: 'file_1', seconds: 754 });
    expect(parseMediaRefHref('mediaref://file_1')).toBeNull();
    expect(parseMediaRefHref('mediaref://file_1?t=abc')).toBeNull();
    expect(parseMediaRefHref('pdfref://tb_1?page=2')).toBeNull();
    expect(parseMediaRefHref(null)).toBeNull();
  });

  it('is kept by the internal link schema', () => {
    expect(isInternalLinkHref('mediaref://file_1?t=3')).toBe(true);
  });
});

describe('findMediaRefMarkers', () => {
  it('finds plain-text markers with offsets', () => {
    const text = '一、引言 [媒体@file_9:01:05] 二、[媒体@file_9:1:00:00]';
    const found = findMediaRefMarkers(text);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ resourceId: 'file_9', seconds: 65 });
    expect(text.slice(found[0].from, found[0].to)).toBe('[媒体@file_9:01:05]');
    expect(found[1].seconds).toBe(3600);
  });

  it('ignores text without markers and malformed clocks', () => {
    expect(findMediaRefMarkers('普通文本 [PDF@tb_1:2]')).toEqual([]);
    expect(findMediaRefMarkers('[媒体@file_1:12:75]')).toEqual([]);
  });
});

describe('buildMediaRefDecorations', () => {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { group: 'block', content: 'text*' },
      code_block: { group: 'block', content: 'text*', code: true },
      text: {},
    },
  });

  it('decorates markers in paragraphs but not inside code blocks', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('看 [媒体@file_1:00:30] 这里')]),
      schema.node('code_block', null, [schema.text('[媒体@file_1:00:40]')]),
    ]);
    // 光标在标记内（编辑态）：一条 inline 装饰；代码块里的不处理
    const set = buildMediaRefDecorations(doc, { from: 5, to: 5 });
    const decos = set.find();
    expect(decos).toHaveLength(1);
    expect((decos[0] as any).type.attrs[MEDIA_REF_ANCHOR_ATTR]).toBe('file_1');
    expect((decos[0] as any).type.attrs[MEDIA_REF_SECONDS_ATTR]).toBe('30');
  });
});

describe('handleMediaRefClick', () => {
  const makeView = (root: HTMLElement) =>
    ({ dom: root }) as unknown as import('@milkdown/prose/view').EditorView;
  const received: CustomEvent[] = [];
  const onOpen = (e: Event) => received.push(e as CustomEvent);

  afterEach(() => {
    document.removeEventListener('media-ref:open', onOpen);
    received.length = 0;
  });

  function click(target: Element) {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'target', { value: target });
    return event;
  }

  it('dispatches media-ref:open for decorated text markers', () => {
    document.addEventListener('media-ref:open', onOpen);
    const root = document.createElement('div');
    const span = document.createElement('span');
    span.setAttribute(MEDIA_REF_ANCHOR_ATTR, 'file_7');
    span.setAttribute(MEDIA_REF_SECONDS_ATTR, '90');
    root.appendChild(span);
    const event = click(span);
    expect(handleMediaRefClick(makeView(root), event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(received[0].detail).toEqual({ resourceId: 'file_7', seconds: 90 });
  });

  it('dispatches for mediaref:// anchors and ignores other links', () => {
    document.addEventListener('media-ref:open', onOpen);
    const root = document.createElement('div');
    const a = document.createElement('a');
    a.setAttribute('href', 'mediaref://file_8?t=5');
    const other = document.createElement('a');
    other.setAttribute('href', 'https://example.com');
    root.append(a, other);
    expect(handleMediaRefClick(makeView(root), click(a))).toBe(true);
    expect(handleMediaRefClick(makeView(root), click(other))).toBe(false);
    expect(received).toHaveLength(1);
    expect(received[0].detail).toEqual({ resourceId: 'file_8', seconds: 5 });
  });
});

describe('buildMediaRefDecorations badge mode', () => {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { group: 'block', content: 'text*' },
      text: {},
    },
  });
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('看 [媒体@file_1:01:20] 这里')]),
  ]);

  it('hides the raw marker and shows a time badge without the resource id when the cursor is elsewhere', () => {
    const decos = buildMediaRefDecorations(doc, { from: 1, to: 1 }).find() as any[];
    const raw = decos.find((d) => d.type.attrs?.class === 'crepe-media-ref-raw');
    expect(raw).toBeTruthy();
    const widget = decos.find((d) => typeof d.type.toDOM === 'function');
    const badge = widget.type.toDOM() as HTMLElement;
    expect(badge.textContent).toBe('▶ 01:20');
    expect(badge.getAttribute('data-media-ref-id')).toBe('file_1');
    expect(badge.getAttribute('data-media-ref-seconds')).toBe('80');
  });

  it('shows the raw marker for editing while the cursor is inside it', () => {
    const decos = buildMediaRefDecorations(doc, { from: 6, to: 6 }).find() as any[];
    expect(decos).toHaveLength(1);
    expect(decos[0].type.attrs.class).toBe('crepe-media-ref');
  });
});
