import { describe, expect, it } from 'vitest';
import type { SourceBundle, SourcePage } from '../src/source-range-plan.ts';
import {
  defaultRangePlanOptions, detectProviderLimit, planSourceRanges, validatePlan,
} from '../src/source-range-plan.ts';

function bundle(pages: [number, string][]): SourceBundle {
  return {
    sources: [{ source_id: 's1', page_count: pages.length }],
    pages: pages.map(([page, text]) => ({
      source_id: 's1', page, blob_hash: 'h', width: 1, height: 1,
      text_hint: text !== '' ? text : null,
    })),
    text: '',
    format: 'pdf',
  };
}

function chaptered(count: number): SourceBundle {
  return bundle(Array.from({ length: count }, (_, index) => {
    const page = index + 1;
    const text = (page - 1) % 10 === 0
      ? `第${Math.floor((page - 1) / 10) + 1}章 综合练习\n第 ${page} 页正文`
      : `第 ${page} 页正文`;
    return [page, text] as [number, string];
  }));
}

describe('question_authoring_runner/plan.rs', () => {
  it('chapter_plan_is_a_complete_partition_and_can_be_automatic', () => {
    const source = chaptered(45);
    const plan = planSourceRanges(source, 'context_window', defaultRangePlanOptions());
    validatePlan(plan, source);
    expect(plan.automatic).toBe(true);
    expect(plan.requires_user_selection).toBe(false);
    expect(plan.ranges.reduce((sum, range) => sum + range.page_count, 0)).toBe(45);
    expect(plan.ranges.every(range => range.starts_at_chapter)).toBe(true);
  });

  it('forced_page_split_is_not_auto_accepted', () => {
    const source = bundle(Array.from({ length: 45 }, (_, index) => {
      const page = index + 1;
      return [page, `第 ${page} 页正文`] as [number, string];
    }));
    const plan = planSourceRanges(source, 'context_window', defaultRangePlanOptions());
    validatePlan(plan, source);
    expect(plan.automatic).toBe(false);
    expect(plan.requires_user_selection).toBe(true);
    expect(plan.ranges.reduce((sum, range) => sum + range.page_count, 0)).toBe(45);
  });

  it('answer_section_prevents_automatic_acceptance', () => {
    const texts = Array.from({ length: 40 }, (_, index) => {
      const page = index + 1;
      return [page, `第 ${page} 页正文`] as [number, string];
    });
    texts[30] = [31, '参考答案\n1. B'];
    const plan = planSourceRanges(bundle(texts), 'context_window', defaultRangePlanOptions());
    expect(plan.automatic).toBe(false);
    expect(plan.requires_user_selection).toBe(true);
  });

  it('provider_limit_is_detected_from_stable_codes_and_bodies', () => {
    const context = { message: 'HTTP 400',
      details: { status: 400, body: 'maximum context length exceeded' } };
    expect(detectProviderLimit(context)).toBe('context_window');
    const images = { message: 'HTTP 400',
      details: { status: 400, body: 'too many images in request' } };
    expect(detectProviderLimit(images)).toBe('image_count');
    const truncated = { message: 'truncated',
      details: { code: 'INCOMPLETE_OUTPUT', finish_reason: 'length' } };
    expect(detectProviderLimit(truncated)).toBeNull();
  });

  it('plan_ranges_cover_each_source_without_skips_or_duplicates', () => {
    const pages: SourcePage[] = [
      ...Array.from({ length: 12 }, (_, index) => ({
        source_id: 's1', page: index + 1, blob_hash: 'h', width: 1, height: 1,
        text_hint: `s1 ${index + 1}`,
      })),
      ...Array.from({ length: 8 }, (_, index) => ({
        source_id: 's2', page: index + 1, blob_hash: 'h', width: 1, height: 1,
        text_hint: `s2 ${index + 1}`,
      })),
    ];
    const source: SourceBundle = {
      sources: [{ source_id: 's1', page_count: 12 }, { source_id: 's2', page_count: 8 }],
      pages, text: '', format: 'pdf',
    };
    const plan = planSourceRanges(source, 'request_size', defaultRangePlanOptions());
    expect(plan.ranges.map(range => [range.source_id, range.start_page, range.end_page]))
      .toEqual([['s1', 1, 12], ['s2', 1, 8]]);
    expect(plan.total_pages).toBe(20);
    expect(plan.one_request_policy).toBe(true);
  });
});
