/** `SourceBundle::scoped` / `validate_source_refs`（question_authoring_runner.rs:285-447、874-917）。 */
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../../../platform/errors/api.ts';
import { scopedBundle, validateSourceRefs } from '../src/source-bundle-scope.ts';
import {
  expectedCoverage, isScoped, originalCoverage, scopeComplete, validateCoverage, type SourceBundle,
} from '../src/source-bundle.ts';

function pdfBundle(pages: number): SourceBundle {
  return {
    sources: [{ source_id: 's1', page_count: pages }],
    pages: Array.from({ length: pages }, (_, index) => ({
      source_id: 's1', page: index + 1, blob_hash: 'h', width: 1, height: 1, text_hint: null,
    })),
    text: '',
    format: 'pdf',
  };
}

function coverage(from: number, to: number, status: string): JsonValue[] {
  return Array.from({ length: to - from + 1 }, (_, index) => ({ source_id: 's1', page: from + index, status }));
}

function appError(fn: () => unknown): unknown {
  try { fn(); } catch (error) { return (error as { appError: unknown }).appError; }
  throw new Error('expected failure');
}

describe('SourceBundle::scoped', () => {
  // question_authoring_runner/tests.rs::scope_does_not_fabricate_processed_coverage
  it('scope_does_not_fabricate_processed_coverage', () => {
    const bundle = pdfBundle(40);
    const scoped = scopedBundle(bundle, [{ source_id: 's1', start_page: 1, end_page: 20 }]);
    expect(isScoped(scoped)).toBe(true);
    expect(scopeComplete(scoped)).toBe(false);
    expect(expectedCoverage(scoped).size).toBe(20);
    expect(originalCoverage(scoped).size).toBe(40);
    const raw = { coverage: coverage(1, 20, 'processed') };
    expect(() => validateCoverage(raw, scoped)).not.toThrow();
    raw.coverage.push(...coverage(21, 40, 'unprocessed'));
    expect(() => validateCoverage(raw, scoped)).not.toThrow();
    raw.coverage.push({ source_id: 's1', page: 21, status: 'processed' });
    expect(() => validateCoverage(raw, scoped)).toThrow();
    expect(() => validateCoverage({ coverage: coverage(1, 20, 'processed') }, bundle)).toThrow();
  });

  it('selection 元数据追加在来源描述末尾', () => {
    const scoped = scopedBundle(pdfBundle(4), [{ source_id: 's1', start_page: 2, end_page: 3 }]);
    expect(Object.keys(scoped.sources[0]!)).toEqual(['source_id', 'page_count', 'source_route', 'selection']);
    expect(scoped.sources[0]!.selection).toEqual({ ranges: [{ start_page: 2, end_page: 3 }],
      original_page_count: 4, selected_page_count: 2, complete_source: false });
    expect(scoped.pages.map(page => page.page)).toEqual([2, 3]);
  });

  it('各错误分支的消息与 Rust 一致', () => {
    const bundle = pdfBundle(3);
    const scoped = scopedBundle(bundle, [{ source_id: 's1', start_page: 1, end_page: 1 }]);
    expect(appError(() => scopedBundle(scoped, [{ source_id: 's1', start_page: 1, end_page: 1 }])))
      .toMatchObject({ message: '已裁剪的来源不能再次选择范围，请从完整原始来源重新选择' });
    expect(appError(() => scopedBundle(bundle, []))).toMatchObject({ message: '未选择任何原始来源范围' });
    expect(appError(() => scopedBundle(bundle, [{ source_id: 'x' }])))
      .toMatchObject({ message: '范围引用了不存在的来源: x' });
    expect(appError(() => scopedBundle(bundle, [{ source_id: 's1', start_page: 2, end_page: 5 }])))
      .toMatchObject({ message: '来源 s1 的页码范围 2-5 无效（原始共 3 页）' });
    expect(appError(() => scopedBundle(bundle, [{ source_id: 's1', start_page: 1, end_page: 2 },
      { source_id: 's1', start_page: 2, end_page: 2 }]))).toMatchObject({ message: '来源 s1 第 2 页被重复选择' });
    expect(appError(() => scopedBundle(bundle, [{ source_id: 's1' }])))
      .toMatchObject({ message: '分页来源 s1 必须给出闭区间页码' });
    const text: SourceBundle = { sources: [{ source_id: 's1', page_count: null }], pages: [], text: '正文', format: 'txt' };
    expect(appError(() => scopedBundle(text, [{ source_id: 's1', start_page: 1, end_page: 1 }])))
      .toMatchObject({ message: '无分页来源 s1 只能整份选择' });
    expect(appError(() => scopedBundle(text, [{ source_id: 's1' }, { source_id: 's1' }])))
      .toMatchObject({ message: '来源 s1 被重复选择' });
    const missing: SourceBundle = { ...pdfBundle(3), pages: [] };
    expect(appError(() => scopedBundle(missing, [{ source_id: 's1', start_page: 1, end_page: 1 }])))
      .toMatchObject({ message: '所选原始页在来源中不存在（页图缺失），不能伪造处理覆盖' });
  });

  it('多文件来源整份选择时按 <source> 段无损截取正文', () => {
    const bundle: SourceBundle = {
      sources: [{ source_id: 'file1_s1', page_count: null }, { source_id: 'file2_s1', page_count: null }],
      pages: [],
      text: '\n\n<source id="file1_s1" name="a">\n甲\n</source>\n\n\n<source id="file2_s1" name="b">\n乙\n</source>\n',
      format: 'bundle',
    };
    const scoped = scopedBundle(bundle, [{ source_id: 'file2_s1' }]);
    expect(scoped.text).toBe('\n\n<source id="file2_s1">\n乙\n</source>\n');
    expect(scoped.sources[0]!.selection).toMatchObject({ selected_page_count: 0, selected_whole: false });
    expect(scoped.sources[1]!.selection).toMatchObject({ selected_page_count: null, selected_whole: true });
  });
});

describe('validate_source_refs', () => {
  const bundle = pdfBundle(2);
  const ref = (page: number) => ({ source_id: 's1', page });
  it('缺少来源定位、引用未提供页、抽取答案无来源均拒绝', () => {
    expect(appError(() => validateSourceRefs({ questions: [{ source_refs: [] }] }, bundle)))
      .toMatchObject({ message: '抽取内容缺少原始来源定位，未创建正式题目' });
    expect(appError(() => validateSourceRefs({ materials: [{ source_refs: [ref(1)], figures: [ref(3)] }] }, bundle)))
      .toMatchObject({ message: 'figures 引用了未提供的来源或页码' });
    expect(appError(() => validateSourceRefs({ mode: 'extract',
      questions: [{ source_refs: [ref(1)], answer: 'A', answer_origin: 'source' }] }, bundle)))
      .toMatchObject({ message: '抽取题的答案缺少明确来源，禁止自动解题填充答案' });
  });

  it('空答案、generate 模式与有来源的答案通过', () => {
    expect(() => validateSourceRefs({ mode: 'extract', questions: [
      { source_refs: [ref(1)], answer: '' },
      { source_refs: [ref(2)], answer: null },
      { source_refs: [ref(2)], answer: 'B', answer_origin: 'source', answer_source_refs: [ref(2)] },
    ] }, bundle)).not.toThrow();
    expect(() => validateSourceRefs({ mode: 'generate', questions: [{ source_refs: [ref(1)], answer: 'A' }] }, bundle))
      .not.toThrow();
  });
});
