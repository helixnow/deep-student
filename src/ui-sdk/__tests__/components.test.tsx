/**
 * The visual building blocks community plugins get from `@deepstudent/ui`: MathText renders only KaTeX output and
 * falls back to the source text; the list/search/badge pieces behave as their props say.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DsBadge, DsButton, DsCard, DsListItem, DsSearchInput, MathText } from '../index';

describe('MathText', () => {
  it('renders a formula with KaTeX', async () => {
    const { container } = render(<MathText tex="E = mc^2" />);
    await waitFor(() => expect(container.querySelector('[data-math="inline"] .katex')).not.toBeNull());
    expect(container.querySelector('annotation')?.textContent).toBe('E = mc^2');
  });

  it('renders display formulas as their own block', async () => {
    const { container } = render(<MathText tex="\frac{a}{b}" display />);
    await waitFor(() => expect(container.querySelector('[data-math="display"] .katex-display')).not.toBeNull());
  });

  it('keeps the text around $…$ as text and renders each formula', async () => {
    const { container } = render(<MathText text={'面积 $S = \\pi r^2$，周长 $$C = 2\\pi r$$ 价格 \\$5'} />);
    await waitFor(() => expect(container.querySelectorAll('.katex').length).toBe(2));
    expect(container.textContent).toContain('面积 ');
    expect(container.textContent).toContain('价格 $5');
    expect(container.querySelector('[data-math="display"]')).not.toBeNull();
  });

  it('shows the source text when the formula does not parse', async () => {
    const { container } = render(<><MathText tex="\frac{a}{" /><MathText tex="x^2" /></>);
    await waitFor(() => expect(container.querySelector('.katex')).not.toBeNull());
    expect(container.querySelector('[data-math-source]')?.textContent).toBe('$\\frac{a}{$');
  });

  it('never turns plugin input into markup: no links, no raw HTML', async () => {
    const { container } = render(<MathText text={'<img src=x onerror="alert(1)"> $\\href{javascript:alert(1)}{x}$ $x$'} />);
    await waitFor(() => expect(container.querySelector('.katex')).not.toBeNull());
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    // trust: false — \href is shown as (red) source text, never as an attribute.
    expect(container.querySelector('[href]')).toBeNull();
    expect(container.innerHTML).not.toMatch(/="javascript:/);
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
  });
});

describe('list, search and badge pieces', () => {
  it('DsSearchInput reports the typed string', () => {
    const changes: string[] = [];
    function Search() {
      const [value, setValue] = useState('');
      return <DsSearchInput value={value} placeholder="搜索公式" onChange={next => { changes.push(next); setValue(next); }} />;
    }
    render(<Search />);
    const input = screen.getByRole('searchbox', { name: '搜索公式' });
    fireEvent.change(input, { target: { value: '勾股' } });
    expect(changes).toEqual(['勾股']);
    expect((input as HTMLInputElement).value).toBe('勾股');
  });

  it('DsListItem is a button only when clickable, with title, description and trailing content', () => {
    const onClick = vi.fn();
    render(
      <DsCard flush>
        <DsListItem title="勾股定理" description="直角三角形" trailing={<DsBadge>几何</DsBadge>} onClick={onClick} />
        <DsListItem title="静态行" />
      </DsCard>,
    );
    const button = screen.getByRole('button', { name: /勾股定理/ });
    expect(button.textContent).toContain('直角三角形');
    expect(button.textContent).toContain('几何');
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: 'Enter' });
    expect(onClick).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: /静态行/ })).toBeNull();
    expect(screen.getByText('静态行')).toBeTruthy();
  });

  it('a button inside a clickable row handles its own click', () => {
    const row = vi.fn();
    const inner = vi.fn();
    render(<DsListItem title="行" onClick={row} trailing={<DsButton onClick={inner}>收藏</DsButton>} />);
    fireEvent.click(screen.getByText('收藏'));
    expect(inner).toHaveBeenCalledTimes(1);
    expect(row).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('行'));
    expect(row).toHaveBeenCalledTimes(1);
  });
});
