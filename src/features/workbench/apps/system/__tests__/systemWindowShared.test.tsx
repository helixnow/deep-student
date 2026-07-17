/**
 * SystemWindowShared 呈现件测试
 *
 * 覆盖 O18 打磨轮补充的 UI 契约：
 * - 骨架屏的 a11y 语义（role=status + aria-busy）；
 * - 窄窗抽屉的开合、Esc 关闭与焦点管理（开→焦点入面板，关→还给把手）。
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { WbSysSidebarLayout, WbSysSkeleton } from '../SystemWindowShared';

describe('WbSysSkeleton', () => {
  it('exposes loading semantics for screen readers', () => {
    render(<WbSysSkeleton variant="sidebar" />);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.getAttribute('data-wb-sys-skeleton')).toBe('sidebar');
  });
});

describe('WbSysSidebarLayout（compact 抽屉）', () => {
  const renderCompact = () =>
    render(
      <WbSysSidebarLayout
        sizeClass="compact"
        navLabel="待办导航"
        sidebar={<button type="button">列表 A</button>}
      >
        <div>主内容</div>
      </WbSysSidebarLayout>,
    );

  it('wide 档并排渲染侧栏，不出现抽屉把手', () => {
    render(
      <WbSysSidebarLayout sizeClass="wide" navLabel="待办导航" sidebar={<span>侧栏</span>}>
        <div>主内容</div>
      </WbSysSidebarLayout>,
    );
    expect(screen.getByText('侧栏')).toBeTruthy();
    expect(document.querySelector('[data-wb-sys-drawer-handle]')).toBeNull();
  });

  it('点把手开抽屉且焦点移入面板，Esc 关闭并把焦点还给把手', () => {
    renderCompact();
    const handle = document.querySelector('[data-wb-sys-drawer-handle]') as HTMLButtonElement;
    const drawer = document.querySelector('[data-wb-sys-drawer]') as HTMLDivElement;
    expect(drawer.getAttribute('data-open')).toBe('false');

    fireEvent.click(handle);
    expect(drawer.getAttribute('data-open')).toBe('true');
    expect(drawer.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(drawer);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(drawer.getAttribute('data-open')).toBe('false');
    expect(document.activeElement).toBe(handle);
  });

  it('点击抽屉内导航项后自动收起', async () => {
    renderCompact();
    const handle = document.querySelector('[data-wb-sys-drawer-handle]') as HTMLButtonElement;
    const drawer = document.querySelector('[data-wb-sys-drawer]') as HTMLDivElement;

    fireEvent.click(handle);
    expect(drawer.getAttribute('data-open')).toBe('true');

    fireEvent.click(screen.getByText('列表 A'));
    // 收起在下一帧（setTimeout 0），等一拍再断言
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(drawer.getAttribute('data-open')).toBe('false');
  });
});
