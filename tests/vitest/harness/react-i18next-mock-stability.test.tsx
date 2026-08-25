/**
 * 测试 harness 契约：react-i18next mock 的 `t` 必须跨渲染身份稳定。
 *
 * 背景：真实 react-i18next 在语言不变时返回稳定的 `t`。若 mock 每次渲染
 * 返回新的 `t` 闭包，所有依赖 `t` 的 useEffect（如 DataGovernanceDashboard
 * 的事件订阅、NotesBacklinksPanel 的加载 effect）会在每次渲染后重跑并
 * setState，形成微任务自激死循环——测试文件无限挂起、堆持续增长，
 * 连 vitest 的 testTimeout 都无法触发。本测试锁定该契约，防止回归。
 */
import React, { useEffect, useRef } from 'react';
import { describe, expect, it } from 'vitest';
import { act, render } from '@testing-library/react';
import { useTranslation } from 'react-i18next';

describe('react-i18next test mock stability contract', () => {
  it('returns an identity-stable t for the same namespace across calls', () => {
    const a = useTranslation('workbench');
    const b = useTranslation('workbench');
    expect(a.t).toBe(b.t);
    expect(useTranslation(['data', 'common']).t).toBe(useTranslation(['data', 'common']).t);
    // 不同 namespace 各自独立，但同样稳定
    expect(useTranslation('data').t).toBe(useTranslation('data').t);
  });

  it('does not re-fire t-dependent effects on unrelated re-renders', () => {
    const effectRuns: number[] = [];

    const Probe: React.FC<{ tick: number }> = ({ tick }) => {
      const { t } = useTranslation('common');
      const runsRef = useRef(0);
      useEffect(() => {
        runsRef.current += 1;
        effectRuns.push(runsRef.current);
      }, [t]);
      return <span>{t('actions.refresh')}{tick}</span>;
    };

    const { rerender } = render(<Probe tick={1} />);
    act(() => {
      rerender(<Probe tick={2} />);
      rerender(<Probe tick={3} />);
    });

    // t 身份稳定 → effect 只在挂载时运行一次
    expect(effectRuns).toEqual([1]);
  });

  it('still resolves translations with the default namespace', () => {
    const { t } = useTranslation('data');
    expect(t('governance.tab_backup')).toBe('备份');
    expect(t('data:governance.tab_overview')).toBe('概览');
  });
});
