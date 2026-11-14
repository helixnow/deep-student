import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { useSlot, useUiKernel } from '../../ui-kernel/react';
import { officialUiRender, renderWithOfficialUi } from './render';

it('shares a real official kernel across the initial render and rerenders, with explicit cleanup', async () => {
  const seen: unknown[] = [];
  function Consumer({ label }: { label: string }) {
    seen.push(useUiKernel());
    return <span>{label}</span>;
  }
  const result = await renderWithOfficialUi(<Consumer label="first" />);
  expect(result.getByText('first')).toBeTruthy();
  result.rerender(<Consumer label="second" />);
  expect(result.getByText('second')).toBeTruthy();
  expect(seen).toEqual([result.kernel, result.kernel]);
  await result.dispose();
  expect(result.kernel.list()).toEqual([]);
});

describe('officialUiRender', () => {
  const render = officialUiRender();

  it('wraps renders and rerenders in one kernel that has the official nav slot, inside a caller wrapper', () => {
    const kernels = new Set<unknown>();
    function Nav({ label }: { label: string }) {
      kernels.add(useUiKernel());
      return <span>{`${label}:${useSlot('nav').length > 0 ? 'nav' : 'empty'}`}</span>;
    }
    const Outer = ({ children }: { children: ReactNode }) => <section data-testid="outer">{children}</section>;
    const view = render(<Nav label="a" />, { wrapper: Outer });
    expect(view.getByTestId('outer').textContent).toBe('a:nav');
    view.rerender(<Nav label="b" />);
    expect(view.getByTestId('outer').textContent).toBe('b:nav');
    expect(kernels.size).toBe(1);
  });
});
