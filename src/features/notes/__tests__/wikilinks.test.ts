import { describe, expect, it } from 'vitest';

import {
  createWikiLinkIndex,
  getWikiLinkRelationships,
  normalizeWikiLinkHeading,
  parseNoteLinks,
  parseNoteMentions,
  parseWikiLinks,
  resolveWikiLinks,
  wikiLinkHeadingsEqual,
} from '../wikilinks';

describe('wikilinks', () => {
  it('parses targets and labels while ignoring fenced code blocks', () => {
    const markdown = [
      'Read [[note_1]] and [[Calculus|the calculus note]].',
      '```md',
      '[[ignored-fence]]',
      '```',
      '\\[[escaped]]',
      '~~~text',
      '[[also-ignored]]',
      '~~~',
      'Then [[final|label|with pipe]].',
    ].join('\n');

    expect(parseWikiLinks(markdown)).toEqual([
      {
        raw: '[[note_1]]',
        target: 'note_1',
        label: undefined,
        start: markdown.indexOf('[[note_1]]'),
        end: markdown.indexOf('[[note_1]]') + '[[note_1]]'.length,
      },
      {
        raw: '[[Calculus|the calculus note]]',
        target: 'Calculus',
        label: 'the calculus note',
        start: markdown.indexOf('[[Calculus|the calculus note]]'),
        end: markdown.indexOf('[[Calculus|the calculus note]]') + '[[Calculus|the calculus note]]'.length,
      },
      {
        raw: '[[final|label|with pipe]]',
        target: 'final',
        label: 'label|with pipe',
        start: markdown.indexOf('[[final|label|with pipe]]'),
        end: markdown.indexOf('[[final|label|with pipe]]') + '[[final|label|with pipe]]'.length,
      },
    ]);
  });

  it('resolves IDs before titles and resolves duplicate titles deterministically', () => {
    const index = createWikiLinkIndex([
      { id: 'note_z', title: 'Shared title' },
      { id: 'note_a', title: 'Shared title' },
      { id: 'a-title', title: 'note_z' },
    ]);

    expect(index.resolve(' note_z ')).toEqual({
      target: 'note_z',
      noteId: 'note_z',
      matchedBy: 'id',
      ambiguous: false,
      candidateIds: ['note_z'],
    });
    expect(index.resolve('Shared title')).toEqual({
      target: 'Shared title',
      noteId: 'note_a',
      matchedBy: 'title',
      ambiguous: true,
      candidateIds: ['note_a', 'note_z'],
    });
    expect(index.resolve('missing')).toMatchObject({
      noteId: null,
      matchedBy: null,
      candidateIds: [],
    });
  });

  it('resolves titles case-insensitively while preserving the raw target', () => {
    const index = createWikiLinkIndex([
      { id: 'note_calc', title: 'Calculus' },
      { id: 'note_id_case', title: 'irrelevant' },
    ]);

    expect(index.resolve('calculus')).toEqual({
      target: 'calculus',
      noteId: 'note_calc',
      matchedBy: 'title',
      ambiguous: false,
      candidateIds: ['note_calc'],
    });
    expect(index.resolve(' CALCULUS ')).toMatchObject({
      target: 'CALCULUS',
      noteId: 'note_calc',
      matchedBy: 'title',
    });
    // ID matching stays exact: a case-variant ID falls back to title lookup.
    expect(index.resolve('NOTE_ID_CASE')).toMatchObject({
      noteId: null,
      matchedBy: null,
    });
  });

  it('prefers exact ID matches over case-insensitive title collisions', () => {
    const index = createWikiLinkIndex([
      { id: 'note_z', title: 'shared TITLE' },
      { id: 'note_a', title: 'Shared Title' },
      { id: 'Shared Title', title: 'Something else' },
    ]);

    expect(index.resolve('Shared Title')).toEqual({
      target: 'Shared Title',
      noteId: 'Shared Title',
      matchedBy: 'id',
      ambiguous: false,
      candidateIds: ['Shared Title'],
    });
    expect(index.resolve('shared title')).toEqual({
      target: 'shared title',
      noteId: 'note_a',
      matchedBy: 'title',
      ambiguous: true,
      candidateIds: ['note_a', 'note_z'],
    });
  });

  it('indexes heading links against the note while preserving heading metadata', () => {
    const markdown = 'Jump [[Alpha#Methods]] and [[Alpha#Results|the results]] and [[alpha#Cased]].';
    expect(parseWikiLinks(markdown).map(({ target, heading, label }) => ({ target, heading, label }))).toEqual([
      { target: 'Alpha', heading: 'Methods', label: undefined },
      { target: 'Alpha', heading: 'Results', label: 'the results' },
      { target: 'alpha', heading: 'Cased', label: undefined },
    ]);

    const relationships = getWikiLinkRelationships(new Map([
      ['note_alpha', { title: 'Alpha', content: '' }],
      ['note_beta', { title: 'Beta', content: markdown }],
    ]));
    expect(relationships.inboundByNoteId.note_alpha.map((entry) => entry.link.heading)).toEqual([
      'Methods',
      'Results',
      'Cased',
    ]);
  });

 // B9：行内 code（反引号 span）内的 [[...]] / note:// 不再解析，与 
  // 及编辑器 remark 层（只 visit text 节点）对齐。fence/escape 跳过契约不变。
  it('skips wiki links and note mentions inside inline code spans', () => {
    const markdown = [
      'Use `[[not a link]]` but [[Real]] works.',
      'Double ``[No](note://ignored)`` stays code, [Yes](note://note_y) does not.',
      'Unclosed `backtick keeps [[StillParsed]] linkable.',
    ].join('\n');

    expect(parseWikiLinks(markdown).map((link) => link.target)).toEqual(['Real', 'StillParsed']);
    expect(parseNoteMentions(markdown).map((link) => link.target)).toEqual(['note_y']);
  });

  // B10：note://id#heading 的 hash 段写入 WikiLink.heading，且 id 不再吞掉 #
  it('captures note:// heading fragments into WikiLink.heading', () => {
    const markdown = 'See [Alpha](note://note_a#Methods) and [B](note://note_b?x=1#Sec%20One).';
    expect(parseNoteMentions(markdown)).toEqual([
      expect.objectContaining({ target: 'note_a', heading: 'Methods', label: 'Alpha' }),
      expect.objectContaining({ target: 'note_b', heading: 'Sec One', label: 'B' }),
    ]);

    const relationships = getWikiLinkRelationships(new Map([
      ['note_a', { title: 'Alpha', content: '' }],
      ['note_b', { title: 'Beta', content: '[Alpha](note://note_a#Methods)' }],
    ]));
    expect(relationships.inboundByNoteId.note_a).toHaveLength(1);
    expect(relationships.inboundByNoteId.note_a[0].link.heading).toBe('Methods');
  });

  it('indexes @ mentions stored as note:// markdown links with wiki links', () => {
    const markdown = 'See [Alpha](note://note_a) and [[Beta]].\n```md\n[No](note://ignored)\n```';
    expect(parseNoteMentions(markdown)).toEqual([
      expect.objectContaining({ target: 'note_a', label: 'Alpha', raw: '[Alpha](note://note_a)' }),
    ]);
    expect(parseNoteLinks(markdown).map((link) => link.target)).toEqual(['note_a', 'Beta']);

    const relationships = getWikiLinkRelationships(new Map([
      ['note_a', { title: 'Alpha', content: '' }],
      ['note_b', { title: 'Beta', content: '[Alpha](note://note_a)' }],
    ]));
    expect(relationships.inboundByNoteId.note_a).toHaveLength(1);
    expect(relationships.inboundByNoteId.note_a[0].link.label).toBe('Alpha');
  });

  it('builds outbound, inbound, and unresolved relationships from a note-content map', () => {
    const relationships = getWikiLinkRelationships(new Map([
      ['note_b', {
        title: 'Second',
        content: '[[note_a]] [[First|first note]] [[missing]]',
      }],
      ['note_a', {
        title: 'First',
        content: '[[Second]]',
      }],
    ]));

    expect(relationships.outboundByNoteId.note_a.map((link) => link.targetId)).toEqual(['note_b']);
    expect(relationships.outboundByNoteId.note_b.map((link) => link.targetId)).toEqual(['note_a', 'note_a']);
    expect(relationships.inboundByNoteId.note_a.map((link) => link.sourceId)).toEqual(['note_b', 'note_b']);
    expect(relationships.inboundByNoteId.note_b.map((link) => link.sourceId)).toEqual(['note_a']);
    expect(relationships.unresolved).toHaveLength(1);
    expect(relationships.unresolved[0]).toMatchObject({
      sourceId: 'note_b',
      link: { target: 'missing' },
      resolution: { noteId: null },
    });

    expect(resolveWikiLinks('[[First]] [[unknown]]', [
      { id: 'note_a', title: 'First' },
    ]).map((link) => link.resolution.noteId)).toEqual(['note_a', null]);
  });

  it('normalizes whitespace around targets and before aliases for relationships', () => {
    const relationships = getWikiLinkRelationships(new Map([
      ['note_alpha', { title: 'Alpha', content: '' }],
      ['note_beta', {
        title: 'Beta',
        content: '[[ Alpha ]] [[Alpha | spaced alias]] [[ Alpha | both padded]]',
      }],
    ]));

    expect(relationships.outboundByNoteId.note_beta.map((link) => ({
      targetId: link.targetId,
      target: link.link.target,
      label: link.link.label,
    }))).toEqual([
      { targetId: 'note_alpha', target: 'Alpha', label: undefined },
      { targetId: 'note_alpha', target: 'Alpha', label: 'spaced alias' },
      { targetId: 'note_alpha', target: 'Alpha', label: 'both padded' },
    ]);
    expect(relationships.inboundByNoteId.note_alpha).toHaveLength(3);
  });

  it('normalizes heading anchors across case, width, CJK punctuation and spaces', () => {
    expect(normalizeWikiLinkHeading('  第一章：绪 论  ')).toBe('第一章:绪论');
    expect(normalizeWikiLinkHeading('Ｈｅｌｌｏ　Ｗｏｒｌｄ')).toBe('helloworld');
    expect(wikiLinkHeadingsEqual('第一章：绪论', '第一章: 绪论')).toBe(true);
    expect(wikiLinkHeadingsEqual('Getting Started', 'getting   started')).toBe(true);
    expect(wikiLinkHeadingsEqual('一、极限，与连续', '一,极限,与连续')).toBe(true);
    expect(wikiLinkHeadingsEqual('第一章', '第二章')).toBe(false);
  });
});
