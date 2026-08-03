import { Schema } from '@milkdown/prose/model';
import { EditorState, TextSelection } from '@milkdown/prose/state';
import { describe, expect, it, vi } from 'vitest';

import { handleMentionLinkClick } from '../click';
import { applyMentionInsert } from '../insertMention';
import { buildNoteHref, parseNoteHref, parseNoteHrefHeading } from '../protocol';
import { MENTION_EVENTS } from '../types';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      content: 'inline*',
      group: 'block',
      parseDOM: [{ tag: 'p' }],
      toDOM: () => ['p', 0],
    },
    text: { group: 'inline' },
  },
  marks: {
    link: {
      attrs: {
        href: { default: null },
        title: { default: null },
      },
      inclusive: false,
      parseDOM: [
        {
          tag: 'a[href]',
          getAttrs: (dom) => ({
            href: (dom as HTMLElement).getAttribute('href'),
            title: (dom as HTMLElement).getAttribute('title'),
          }),
        },
      ],
      toDOM: (mark) => ['a', { href: mark.attrs.href, title: mark.attrs.title }, 0],
    },
  },
});

function stateWithText(text: string, cursor: number) {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, text ? [schema.text(text)] : []),
  ]);
  return EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(doc, cursor),
  });
}

describe('protocol note://', () => {
  it('builds and parses note href', () => {
    expect(buildNoteHref('note_abc')).toBe('note://note_abc');
    expect(parseNoteHref('note://note_abc')).toBe('note_abc');
    expect(parseNoteHref('note://note_abc?x=1')).toBe('note_abc');
    expect(parseNoteHref('https://example.com')).toBeNull();
    expect(parseNoteHref('note://')).toBeNull();
  });

  // B10 联动：hash 段解析为笔记内标题
  it('parses the heading fragment from note:// hrefs', () => {
    expect(parseNoteHrefHeading('note://note_abc#Methods')).toBe('Methods');
    expect(parseNoteHrefHeading('note://note_abc#Sec%20One')).toBe('Sec One');
    expect(parseNoteHrefHeading('note://note_abc')).toBeNull();
    expect(parseNoteHrefHeading('note://note_abc#')).toBeNull();
    expect(parseNoteHrefHeading('https://example.com#x')).toBeNull();
  });
});

describe('applyMentionInsert', () => {
  it('replaces @query with title link mark note://id', () => {
    // doc: <p>@calc</p>  positions: 0=doc, 1=p start, 1..5 = @calc, cursor after
    const state = stateWithText('@calc', 6);
    const from = 1; // start of paragraph content = @
    const to = 6;
    const tr = applyMentionInsert(state, from, to, {
      id: 'note_1',
      title: 'Calculus',
    });
    expect(tr).not.toBeNull();
    const next = state.apply(tr!);
    const text = next.doc.textContent;
    expect(text).toBe('Calculus');

    let foundHref: string | null = null;
    next.doc.descendants((node) => {
      if (!node.isText) return;
      const link = schema.marks.link.isInSet(node.marks);
      if (link) foundHref = link.attrs.href as string;
    });
    expect(foundHref).toBe('note://note_1');
  });

  it('falls back to id when title is blank', () => {
    const state = stateWithText('@x', 3);
    const tr = applyMentionInsert(state, 1, 3, { id: 'note_z', title: '  ' });
    expect(tr).not.toBeNull();
    expect(state.apply(tr!).doc.textContent).toBe('note_z');
  });

  it('returns null without link mark in schema', () => {
    const bare = new Schema({
      nodes: {
        doc: { content: 'block+' },
        paragraph: { content: 'inline*', group: 'block', toDOM: () => ['p', 0] },
        text: { group: 'inline' },
      },
    });
    const doc = bare.node('doc', null, [bare.node('paragraph', null, [bare.text('@a')])]);
    const state = EditorState.create({ schema: bare, doc });
    expect(applyMentionInsert(state, 1, 3, { id: 'n', title: 'T' })).toBeNull();
  });
});

describe('handleMentionLinkClick', () => {
  it('dispatches DSTU_OPEN_NOTE for note:// anchors', () => {
    const root = document.createElement('div');
    const a = document.createElement('a');
    a.setAttribute('href', 'note://note_99');
    a.textContent = 'Title';
    root.appendChild(a);

    const view = {
      dom: root,
    } as unknown as import('@milkdown/prose/view').EditorView;

    const events: CustomEvent[] = [];
    const onOpen = (e: Event) => {
      events.push(e as CustomEvent);
    };
    window.addEventListener(MENTION_EVENTS.OPEN_NOTE, onOpen);

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'target', { value: a });

    const handled = handleMentionLinkClick(view, event);
    window.removeEventListener(MENTION_EVENTS.OPEN_NOTE, onOpen);

    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toEqual({ noteId: 'note_99', source: 'mention' });
  });

  it('carries the href heading fragment into the open event detail', () => {
    const root = document.createElement('div');
    const a = document.createElement('a');
    a.setAttribute('href', 'note://note_42#Sec%20One');
    root.appendChild(a);

    const view = { dom: root } as unknown as import('@milkdown/prose/view').EditorView;
    const events: CustomEvent[] = [];
    const onOpen = (e: Event) => {
      events.push(e as CustomEvent);
    };
    window.addEventListener(MENTION_EVENTS.OPEN_NOTE, onOpen);

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'target', { value: a });
    const handled = handleMentionLinkClick(view, event);
    window.removeEventListener(MENTION_EVENTS.OPEN_NOTE, onOpen);

    expect(handled).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toEqual({
      noteId: 'note_42',
      source: 'mention',
      heading: 'Sec One',
    });
  });

  it('ignores non-note links', () => {
    const root = document.createElement('div');
    const a = document.createElement('a');
    a.setAttribute('href', 'https://example.com');
    root.appendChild(a);

    const view = { dom: root } as unknown as import('@milkdown/prose/view').EditorView;
    const spy = vi.fn();
    window.addEventListener(MENTION_EVENTS.OPEN_NOTE, spy);

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'target', { value: a });
    expect(handleMentionLinkClick(view, event)).toBe(false);

    window.removeEventListener(MENTION_EVENTS.OPEN_NOTE, spy);
    expect(spy).not.toHaveBeenCalled();
  });
});
