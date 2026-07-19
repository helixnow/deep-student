import { describe, expect, it } from 'vitest';

import {
  createWikiLinkIndex,
  getWikiLinkRelationships,
  parseNoteLinks,
  parseNoteMentions,
  parseWikiLinks,
  resolveWikiLinks,
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

  it('indexes heading links against the note while preserving heading metadata', () => {
    const markdown = 'Jump [[Alpha#Methods]] and [[Alpha#Results|the results]].';
    expect(parseWikiLinks(markdown).map(({ target, heading, label }) => ({ target, heading, label }))).toEqual([
      { target: 'Alpha', heading: 'Methods', label: undefined },
      { target: 'Alpha', heading: 'Results', label: 'the results' },
    ]);

    const relationships = getWikiLinkRelationships(new Map([
      ['note_alpha', { title: 'Alpha', content: '' }],
      ['note_beta', { title: 'Beta', content: markdown }],
    ]));
    expect(relationships.inboundByNoteId.note_alpha.map((entry) => entry.link.heading)).toEqual([
      'Methods',
      'Results',
    ]);
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
});
