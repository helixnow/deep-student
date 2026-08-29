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

/**
 * 共享键语法测试向量 —— 前端镜像。
 * canonical 定义：src-tauri/src/vfs/note_props.rs 的 `test_vectors` 模块
 * （写侧 validate_prop_key 与后端搜索 normalize_prop_filters 共用同一组向量）。
 * 改动任一侧键语法时必须同步更新两处向量。
 */
const SHARED_VALID_OPERATOR_KEYS: readonly string[] = [
  'status', 'Status', '优先级', 'due_date', 'sprint-42', 'p0', '_internal', 'k',
];

const SHARED_STORABLE_BUT_NOT_OPERATOR_SEARCHABLE_KEYS: readonly string[] = [
  'my key', // 含空格：操作符按空白分词
  'a:b', // 含冒号：会被解析成 key=a value=b…
  'emoji🙂', // 🙂 不属于 \p{L}\p{N}_-
  '-lead', // 首字符不允许连字符
  '得 分', // CJK + 空格
];

describe('shared prop key syntax vectors (mirror of vfs::note_props::test_vectors)', () => {
  it('parses every valid operator key as a prop filter', () => {
    for (const key of SHARED_VALID_OPERATOR_KEYS) {
      const parsed = parseSearchOperators(`${key}:hit`);
      expect(parsed.props, `合法键 ${key} 应解析为属性过滤器`).toEqual([{ key, value: 'hit' }]);
      expect(parsed.textQuery).toBe('');
    }
  });

  it('cannot express storable-but-unsearchable keys via operator syntax', () => {
    for (const key of SHARED_STORABLE_BUT_NOT_OPERATOR_SEARCHABLE_KEYS) {
      const parsed = parseSearchOperators(`${key}:hit`);
      // 这些键写侧可存，但操作符语法无法完整表达该键：
      // 要么整个 token 落回纯文本，要么被拆解成别的键——绝不会等于原键
      expect(
        parsed.props.some((filter) => filter.key === key),
        `键 ${key} 不应被操作符语法表达`,
      ).toBe(false);
    }
  });

  it('routes reserved operator keys (tag/path) away from prop filters', () => {
    // 保留键在写侧会被拒绝（NOTE_PROPS_RESERVED_KEYS），搜索侧则有专属语义
    const parsed = parseSearchOperators('tag:math path:course title:x');
    expect(parsed.tags).toEqual(['math']);
    expect(parsed.paths).toEqual(['course']);
    // title 等保留键仍会进入 props 过滤器，但写侧存不进（永不命中），
    // 与后端 normalize_prop_filters 的宽松语义一致
    expect(parsed.props).toEqual([{ key: 'title', value: 'x' }]);
  });
});
