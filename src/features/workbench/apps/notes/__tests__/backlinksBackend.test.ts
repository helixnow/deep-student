import { describe, expect, it } from 'vitest';
import {
  backlinkRowToRelationship,
  linkEndFromContent,
  utf8ByteToCharIndex,
  type NoteBacklinkDto,
} from '../backlinksBackend';

describe('utf8ByteToCharIndex', () => {
  it('maps ASCII byte offsets 1:1', () => {
    expect(utf8ByteToCharIndex('hello', 0)).toBe(0);
    expect(utf8ByteToCharIndex('hello', 3)).toBe(3);
    expect(utf8ByteToCharIndex('hello', 5)).toBe(5);
  });

  it('accounts for multi-byte CJK characters (3 bytes each)', () => {
    // "数学" = 6 bytes; the link starts right after it.
    const content = '数学[[Alpha]]';
    expect(utf8ByteToCharIndex(content, 6)).toBe(2);
    expect(content.slice(utf8ByteToCharIndex(content, 6))).toBe('[[Alpha]]');
  });

  it('accounts for 4-byte astral characters (surrogate pairs)', () => {
    const content = '😀[[A]]';
    expect(utf8ByteToCharIndex(content, 4)).toBe(2);
    expect(content.slice(utf8ByteToCharIndex(content, 4))).toBe('[[A]]');
  });

  it('clamps out-of-range and mid-sequence offsets', () => {
    expect(utf8ByteToCharIndex('数学', 100)).toBe(2);
    expect(utf8ByteToCharIndex('数学', -1)).toBe(0);
    // Offset landing inside the first 3-byte character resolves to its start.
    expect(utf8ByteToCharIndex('数学', 1)).toBe(0);
  });
});

describe('linkEndFromContent', () => {
  it('closes wikilinks at ]] and noterefs at )', () => {
    expect(linkEndFromContent('a [[X|alias]] b', 2, 'wikilink')).toBe(13);
    expect(linkEndFromContent('a [T](note://x) b', 2, 'noteref')).toBe(15);
  });

  it('keeps a usable zero-ish range when the closer is missing (stale graph)', () => {
    expect(linkEndFromContent('a [[broken', 2, 'wikilink')).toBe(4);
  });
});

describe('backlinkRowToRelationship', () => {
  const row: NoteBacklinkDto = {
    sourceId: 'note_src',
    sourceTitle: 'Source',
    heading: null,
    alias: 'alias',
    position: 6,
    sourceUpdatedAt: '2026-07-01T00:00:00Z',
  };

  it('maps byte positions to char ranges when content is available', () => {
    const relationship = backlinkRowToRelationship(row, 'note_active', 'Active', '数学[[Active|alias]] tail');
    expect(relationship.sourceId).toBe('note_src');
    expect(relationship.targetId).toBe('note_active');
    expect(relationship.link.start).toBe(2);
    expect(relationship.link.raw).toBe('[[Active|alias]]');
    expect(relationship.link.label).toBe('alias');
    expect(relationship.resolution.noteId).toBe('note_active');
  });

  it('degrades to a zero-width range without content (no snippet, row still renders)', () => {
    const relationship = backlinkRowToRelationship(row, 'note_active', 'Active', undefined);
    expect(relationship.link.start).toBe(0);
    expect(relationship.link.end).toBe(0);
    expect(relationship.link.raw).toBe('');
  });

  it('detects note:// reference links by their opening bracket shape', () => {
    const content = 'see [Active](note://note_active) end';
    const noteRefRow: NoteBacklinkDto = { ...row, alias: null, position: 4 };
    const relationship = backlinkRowToRelationship(noteRefRow, 'note_active', 'Active', content);
    expect(relationship.link.raw).toBe('[Active](note://note_active)');
  });
});
