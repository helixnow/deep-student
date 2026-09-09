/**
 * CompletionCard G07-a 验收徽章测试
 *
 * 覆盖：五种 verdict 的徽章渲染、无 finalization 的旧块不显示徽章、
 * 例外列表展开/收起、徽章与模型自述 result 并列展示、inline 形态。
 *
 * react-i18next 走全局别名 mock（tests/ct/mocks/react-i18next.tsx），
 * 新增的 completion.finalization.* 键尚未进 locale 文件 → 按组件内
 * defaultValue 中文兜底文案断言。
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  CompletionCard,
  extractCompletionData,
  extractFinalization,
  type FinalizationData,
  type FinalizationVerdict,
} from '../CompletionCard';

function finalization(
  verdict: FinalizationVerdict,
  exceptions: FinalizationData['exceptions'] = [],
): FinalizationData {
  return { verdict, exceptions };
}

const HASH_MISMATCH_EXCEPTION = {
  check: 'artifacts_exist',
  kind: 'hash_mismatch',
  path: 'report.md',
  message: 'artifact sha256 mismatch: declared aaa, actual bbb',
};

describe('CompletionCard 验收徽章（五种 verdict）', () => {
  it.each([
    ['verified_complete', '已验收'],
    ['complete_with_exceptions', '完成（有例外）'],
    ['partial', '部分完成'],
    ['blocked', '受阻'],
    ['outcome_unknown', '结果未知'],
  ] as Array<[FinalizationVerdict, string]>)('%s → %s', (verdict, label) => {
    render(
      <CompletionCard data={{ result: '模型自述完成', finalization: finalization(verdict) }} />,
    );
    const badge = screen.getByTestId('completion-finalization-badge');
    expect(badge).toHaveAttribute('data-verdict', verdict);
    expect(badge).toHaveTextContent(label);
    // 模型自述与验收结论并列展示：徽章不替代 result 文本
    expect(screen.getByText('模型自述完成')).toBeInTheDocument();
  });

  it('无 finalization 字段的旧完成块不显示徽章（旧行为零变化）', () => {
    render(<CompletionCard data={{ result: '模型自述完成' }} />);
    expect(screen.queryByTestId('completion-finalization-badge')).toBeNull();
    expect(screen.getByText('模型自述完成')).toBeInTheDocument();
  });

  it('verdict 为未知字符串时按缺失处理，不显示徽章', () => {
    const data = extractCompletionData(undefined, {
      result: 'done',
      finalization: { verdict: 'not_a_verdict', exceptions: [] },
    });
    expect(data.finalization).toBeUndefined();
  });
});

describe('CompletionCard 例外列表展开', () => {
  it('complete_with_exceptions：默认收起，点击展开显示 kind/path/message，再点收起', () => {
    render(
      <CompletionCard
        data={{
          result: 'done',
          finalization: finalization('complete_with_exceptions', [HASH_MISMATCH_EXCEPTION]),
        }}
      />,
    );
    // 默认收起
    expect(screen.queryByTestId('completion-finalization-exceptions')).toBeNull();
    const toggle = screen.getByRole('button', { name: /例外项（1）/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const list = screen.getByTestId('completion-finalization-exceptions');
    expect(list).toHaveTextContent('哈希不符');
    expect(list).toHaveTextContent('report.md');
    expect(list).toHaveTextContent('artifact sha256 mismatch: declared aaa, actual bbb');

    fireEvent.click(toggle);
    expect(screen.queryByTestId('completion-finalization-exceptions')).toBeNull();
  });

  it('partial：例外列表同样可展开', () => {
    render(
      <CompletionCard
        data={{
          result: 'done',
          finalization: finalization('partial', [
            { check: 'artifacts_exist', kind: 'artifact_missing', path: 'missing.md', message: 'declared artifact does not exist' },
          ]),
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /例外项（1）/ }));
    const list = screen.getByTestId('completion-finalization-exceptions');
    expect(list).toHaveTextContent('产物缺失');
    expect(list).toHaveTextContent('missing.md');
  });

  it('无例外时不渲染展开按钮', () => {
    render(
      <CompletionCard data={{ result: 'done', finalization: finalization('blocked') }} />,
    );
    expect(screen.getByTestId('completion-finalization-badge')).toHaveTextContent('受阻');
    expect(screen.queryByRole('button', { name: /例外项/ })).toBeNull();
  });
});

describe('CompletionCard inline 形态', () => {
  it('inline variant 同样显示徽章与例外入口', () => {
    render(
      <CompletionCard
        variant="inline"
        data={{
          result: 'done',
          finalization: finalization('partial', [HASH_MISMATCH_EXCEPTION]),
        }}
      />,
    );
    expect(screen.getByTestId('completion-finalization-badge')).toHaveTextContent('部分完成');
    expect(screen.getByText('done')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /例外项（1）/ }));
    expect(screen.getByTestId('completion-finalization-exceptions')).toHaveTextContent('report.md');
  });
});

describe('extractFinalization / extractCompletionData', () => {
  it('从 toolOutput 顶层读取 finalization（后端写入位置）', () => {
    const data = extractCompletionData(undefined, {
      completed: true,
      result: 'done',
      task_completed: true,
      finalization: {
        verdict: 'partial',
        exceptions: [
          { check: 'artifacts_exist', kind: 'artifact_missing', path: 'a.md', message: 'not found' },
        ],
        checks_run: ['artifacts_exist'],
      },
    });
    expect(data.result).toBe('done');
    expect(data.finalization?.verdict).toBe('partial');
    expect(data.finalization?.exceptions).toHaveLength(1);
    expect(data.finalization?.exceptions[0]).toEqual({
      check: 'artifacts_exist',
      kind: 'artifact_missing',
      path: 'a.md',
      message: 'not found',
    });
  });

  it('兼容嵌套在 result 内的 finalization', () => {
    const fin = extractFinalization({
      result: {
        result: 'done',
        finalization: { verdict: 'verified_complete' },
      },
    });
    expect(fin).toEqual({ verdict: 'verified_complete', exceptions: [] });
  });

  it('exceptions 缺省 / 非数组 / 条目缺字段时防御性解析', () => {
    expect(extractFinalization({ finalization: { verdict: 'blocked' } })).toEqual({
      verdict: 'blocked',
      exceptions: [],
    });
    const fin = extractFinalization({
      finalization: {
        verdict: 'outcome_unknown',
        exceptions: [{ message: 'locator unavailable' }, 'garbage', null],
      },
    });
    expect(fin?.exceptions).toEqual([
      { check: undefined, kind: undefined, path: undefined, message: 'locator unavailable' },
    ]);
  });

  it('非对象 toolOutput / 无 finalization → undefined', () => {
    expect(extractFinalization(undefined)).toBeUndefined();
    expect(extractFinalization('string')).toBeUndefined();
    expect(extractFinalization({ result: 'done' })).toBeUndefined();
    expect(extractCompletionData(undefined, { result: 'done' }).finalization).toBeUndefined();
  });
});
