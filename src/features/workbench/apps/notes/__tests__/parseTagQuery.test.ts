import { describe, expect, it } from 'vitest';
import {
  getNodeTags,
  nodeMatchesTags,
  parseTagQuery,
  removeTagFromQuery,
} from '../parseTagQuery';

describe('parseTagQuery', () => {
  it('returns empty tags for plain queries', () => {
    expect(parseTagQuery('quadratic formula')).toEqual({
      textQuery: 'quadratic formula',
      tags: [],
    });
  });

  it('extracts bare and quoted tag tokens', () => {
    expect(parseTagQuery('hello tag:math tag:"linear algebra" world')).toEqual({
      textQuery: 'hello world',
      tags: ['math', 'linear algebra'],
    });
  });

  it('deduplicates tags case-insensitively while preserving first casing', () => {
    expect(parseTagQuery('tag:Math tag:math tag:MATH')).toEqual({
      textQuery: '',
      tags: ['Math'],
    });
  });

  it('supports tag-only queries', () => {
    expect(parseTagQuery('tag:physics')).toEqual({
      textQuery: '',
      tags: ['physics'],
    });
  });

  it('ignores empty quoted tag tokens', () => {
    expect(parseTagQuery('alpha tag:"" beta')).toEqual({
      textQuery: 'alpha beta',
      tags: [],
    });
  });
});

describe('removeTagFromQuery', () => {
  it('removes a single tag token and trims leftover spaces', () => {
    expect(removeTagFromQuery('alpha tag:math beta', 'math')).toBe('alpha beta');
    expect(removeTagFromQuery('tag:math', 'math')).toBe('');
  });

  it('is case-insensitive for the tag name', () => {
    expect(removeTagFromQuery('tag:Math note', 'math')).toBe('note');
  });
});

describe('nodeMatchesTags', () => {
  it('reads tags from metadata and applies intersection', () => {
    const metadata = { tags: ['Math', 'Physics'] };
    expect(getNodeTags(metadata)).toEqual(['Math', 'Physics']);
    expect(nodeMatchesTags(metadata, ['math'])).toBe(true);
    expect(nodeMatchesTags(metadata, ['math', 'chemistry'])).toBe(false);
    expect(nodeMatchesTags(undefined, ['math'])).toBe(false);
    expect(nodeMatchesTags(metadata, [])).toBe(true);
  });
});
