import { describe, expect, it } from 'vitest';
import {
  getNodeProps,
  getNodeTags,
  nodeMatchesProps,
  nodeMatchesTags,
  parseSearchOperators,
  parseTagQuery,
  pathMatchesFilters,
  removeOperatorFromQuery,
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

describe('parseSearchOperators', () => {
  it('extracts tag, path, and generic key:value operators from mixed queries', () => {
    expect(parseSearchOperators('quadratic tag:math path:course/algebra status:done')).toEqual({
      textQuery: 'quadratic',
      tags: ['math'],
      paths: ['course/algebra'],
      props: [{ key: 'status', value: 'done' }],
    });
  });

  it('supports quoted values with spaces for every operator kind', () => {
    expect(parseSearchOperators('tag:"linear algebra" path:"my folder" status:"in progress"')).toEqual({
      textQuery: '',
      tags: ['linear algebra'],
      paths: ['my folder'],
      props: [{ key: 'status', value: 'in progress' }],
    });
  });

  it('supports Unicode custom property keys', () => {
    expect(parseSearchOperators('线性代数 状态:已完成')).toEqual({
      textQuery: '线性代数',
      tags: [],
      paths: [],
      props: [{ key: '状态', value: '已完成' }],
    });
  });

  it('deduplicates operators case-insensitively', () => {
    const parsed = parseSearchOperators('tag:Math tag:math path:A path:a status:X STATUS:x');
    expect(parsed.tags).toEqual(['Math']);
    expect(parsed.paths).toEqual(['A']);
    expect(parsed.props).toEqual([{ key: 'status', value: 'X' }]);
  });

  it('keeps URLs as plain text instead of treating them as operators', () => {
    expect(parseSearchOperators('see https://example.com/page')).toEqual({
      textQuery: 'see https://example.com/page',
      tags: [],
      paths: [],
      props: [],
    });
  });

  it('still accepts path values that start with a slash', () => {
    expect(parseSearchOperators('path:/course').paths).toEqual(['/course']);
  });

  it('ignores colons followed by whitespace (plain prose)', () => {
    expect(parseSearchOperators('note: remember this')).toEqual({
      textQuery: 'note: remember this',
      tags: [],
      paths: [],
      props: [],
    });
  });
});

describe('removeOperatorFromQuery', () => {
  it('removes tag, path, and prop tokens including quoted forms', () => {
    expect(removeOperatorFromQuery('alpha tag:math beta', 'tag', 'math')).toBe('alpha beta');
    expect(removeOperatorFromQuery('path:course rest', 'path', 'course')).toBe('rest');
    expect(removeOperatorFromQuery('status:"in progress" rest', 'status', 'in progress')).toBe('rest');
    expect(removeOperatorFromQuery('status:done', 'STATUS', 'DONE')).toBe('');
  });

  it('leaves untouched tokens of other operators alone', () => {
    expect(removeOperatorFromQuery('tag:math path:math', 'tag', 'math')).toBe('path:math');
  });
});

describe('pathMatchesFilters', () => {
  it('requires every path filter to substring-match case-insensitively', () => {
    expect(pathMatchesFilters('Course/Algebra/Note', ['algebra'])).toBe(true);
    expect(pathMatchesFilters('Course/Algebra/Note', ['algebra', 'course'])).toBe(true);
    expect(pathMatchesFilters('Course/Algebra/Note', ['geometry'])).toBe(false);
    expect(pathMatchesFilters('anything', [])).toBe(true);
  });
});

describe('nodeMatchesProps', () => {
  const metadata = { props: { Status: 'In Progress', priority: 2 } };

  it('reads the props object defensively', () => {
    expect(getNodeProps(metadata)).toEqual({ Status: 'In Progress', priority: 2 });
    expect(getNodeProps(undefined)).toEqual({});
    expect(getNodeProps({ props: null })).toEqual({});
    expect(getNodeProps({ props: ['not-an-object'] })).toEqual({});
  });

  it('matches key case-insensitively and value by containment', () => {
    expect(nodeMatchesProps(metadata, [{ key: 'status', value: 'progress' }])).toBe(true);
    expect(nodeMatchesProps(metadata, [{ key: 'priority', value: '2' }])).toBe(true);
    expect(nodeMatchesProps(metadata, [
      { key: 'status', value: 'progress' },
      { key: 'priority', value: '9' },
    ])).toBe(false);
    expect(nodeMatchesProps(undefined, [{ key: 'status', value: 'x' }])).toBe(false);
    expect(nodeMatchesProps(metadata, [])).toBe(true);
  });
});
