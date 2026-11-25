/**
 * SystemWindowShared 呈现件测试
 *
 * 覆盖 O18 打磨轮补充的 UI 契约：
 * - 骨架屏的 a11y 语义（role=status + aria-busy）；
 * - 窄窗抽屉的开合、Esc 关闭与焦点管理（开→焦点入面板，关→还给把手）。
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { WorkbenchSidebarLayout, WbSysSkeleton } from '../SystemWindowShared';

describe('WbSysSkeleton', () => {
  it('exposes loading semantics for screen readers', () => {
    render(<WbSysSkeleton variant="sidebar" />);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.getAttribute('data-wb-sys-skeleton')).toBe('sidebar');
  });
});

describe('WorkbenchSidebarLayout（compact 抽屉）', () => {
  const renderCompact = () =>
    render(
      <WorkbenchSidebarLayout
        sizeClass="compact"
        navLabel="待办导航"
        sidebar={<button type="button">列表 A</button>}
      >
        <div>主内容</div>
      </WorkbenchSidebarLayout>,
    );

  it('wide 档并排渲染侧栏，不出现抽屉把手', () => {
    render(
      <WorkbenchSidebarLayout sizeClass="wide" navLabel="待办导航" sidebar={<span>侧栏</span>}>
        <div>主内容</div>
      </WorkbenchSidebarLayout>,
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

  it('compact 档把抽屉开关放入正文上方的文档流顶条，绝不以 absolute/fixed 覆盖正文', () => {
    const { container } = renderCompact();
    const split = container.querySelector('.wb-sys-split') as HTMLElement;
    const bar = container.querySelector('[data-wb-sys-compact-bar]') as HTMLElement;
    const handle = container.querySelector('[data-wb-sys-drawer-handle]') as HTMLButtonElement;
    const content = container.querySelector('.wb-sys-content') as HTMLElement;

    expect(split.getAttribute('data-wb-sys-drawer-bar')).toBe('true');
    expect(bar).not.toBeNull();
    expect(bar.contains(handle)).toBe(true);
    // 文档流顺序：顶条严格位于正文容器之前
    expect(bar.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const css = readFileSync(resolve(__dirname, '../SystemWindowShared.css'), 'utf8');
    const handleRule = css.match(/\.wb-sys-drawer-handle\s*\{[^}]+\}/)?.[0] ?? '';
    expect(handleRule).toContain('position: relative;');
    expect(handleRule).not.toContain('position: absolute');
    expect(handleRule).not.toContain('position: fixed');
    expect(handleRule).toContain('min-width: 44px;');
    expect(handleRule).toContain('min-height: 44px;');
    expect(css).toMatch(/\.wb-sys-split\[data-wb-sys-drawer-bar='true'\]\s*\{[\s\S]*flex-direction:\s*column;/);
  });

  it('hideDrawerHandle 为 true 时不渲染正文内置把手，Esc 关闭后把焦点还给外部触发按钮', () => {
    const Harness = () => {
      const [open, setOpen] = React.useState(false);
      return (
        <div>
          <button
            type="button"
            data-testid="external-toggle"
            onClick={() => setOpen((v) => !v)}
          >
            切换边栏
          </button>
          <WorkbenchSidebarLayout
            sizeClass="compact"
            navLabel="作文导航"
            drawerOpen={open}
            onDrawerOpenChange={setOpen}
            hideDrawerHandle
            sidebar={<button type="button">列表 A</button>}
          >
            <div>主内容</div>
          </WorkbenchSidebarLayout>
        </div>
      );
    };

    const { container } = render(<Harness />);
    expect(container.querySelector('[data-wb-sys-compact-bar]')).toBeNull();
    expect(container.querySelector('[data-wb-sys-drawer-handle]')).toBeNull();
    expect(container.querySelector('.wb-sys-split')?.getAttribute('data-wb-sys-drawer-bar')).toBe('false');

    const externalToggle = screen.getByTestId('external-toggle');
    externalToggle.focus();
    fireEvent.click(externalToggle);

    const drawer = container.querySelector('[data-wb-sys-drawer]') as HTMLDivElement;
    expect(drawer.getAttribute('data-open')).toBe('true');
    expect(document.activeElement).toBe(drawer);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(drawer.getAttribute('data-open')).toBe('false');
    expect(document.activeElement).toBe(externalToggle);
  });
});
