import { beforeEach, describe, expect, it, vi } from 'vitest';

const reactDomMocks = vi.hoisted(() => ({
  createRoot: vi.fn(),
}));

vi.mock('react-dom/client', () => ({
  createRoot: reactDomMocks.createRoot,
}));

import { getOrCreateReactRoot, resetReactRootForTests } from '../../src/reactRoot';

describe('React root singleton', () => {
  beforeEach(() => {
    resetReactRootForTests();
    reactDomMocks.createRoot.mockReset();
    document.body.replaceChildren();
  });

  it('reuses one root when the entry module executes again', () => {
    const root = {
      render: vi.fn(),
      unmount: vi.fn(),
    };
    reactDomMocks.createRoot.mockReturnValue(root);
    const container = document.createElement('div');

    const first = getOrCreateReactRoot(container);
    const second = getOrCreateReactRoot(container);

    expect(first).toBe(root);
    expect(second).toBe(root);
    expect(reactDomMocks.createRoot).toHaveBeenCalledTimes(1);
    expect(root.unmount).not.toHaveBeenCalled();
  });

  it('replaces the static boot placeholder without reloading', () => {
    const root = {
      render: vi.fn(),
      unmount: vi.fn(),
    };
    reactDomMocks.createRoot.mockReturnValue(root);
    const container = document.createElement('div');
    const placeholder = document.createElement('div');
    placeholder.dataset.dstuReactPlaceholder = 'true';
    container.append(placeholder);

    const result = getOrCreateReactRoot(container);

    expect(result).toBe(root);
    expect(container).toBeEmptyDOMElement();
    expect(reactDomMocks.createRoot).toHaveBeenCalledWith(container);
  });

  it('unmounts a managed root before adopting a replacement container', () => {
    const firstRoot = {
      render: vi.fn(),
      unmount: vi.fn(),
    };
    const secondRoot = {
      render: vi.fn(),
      unmount: vi.fn(),
    };
    reactDomMocks.createRoot
      .mockReturnValueOnce(firstRoot)
      .mockReturnValueOnce(secondRoot);

    getOrCreateReactRoot(document.createElement('div'));
    const replacement = getOrCreateReactRoot(document.createElement('div'));

    expect(firstRoot.unmount).toHaveBeenCalledTimes(1);
    expect(replacement).toBe(secondRoot);
    expect(reactDomMocks.createRoot).toHaveBeenCalledTimes(2);
  });
});
