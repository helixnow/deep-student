import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import { CitationSourceContext } from '../../../../utils/citationSourceContext';
import { CitationBadgeWithPopover } from '../CitationPopover';

function renderBadge(resolve: React.ContextType<typeof CitationSourceContext>, type: 'rag' | 'memory' = 'rag') {
  return render(
    <CitationSourceContext.Provider value={resolve}>
      <CitationBadgeWithPopover citationType={type} citationIndex={1} />
    </CitationSourceContext.Provider>,
  );
}

describe('CitationBadgeWithPopover orphan rag citations', () => {
  it('renders a visible muted non-button pill for orphan [知识库-N] instead of swallowing into blank space', () => {
    const { container } = renderBadge(() => null);
    expect(container.querySelector('[data-citation-anchor]')).toBeNull();
    const orphanPill = container.querySelector('[data-citation-orphan="true"]');
    expect(orphanPill).not.toBeNull();
    expect(orphanPill?.tagName).toBe('SPAN');
    expect(orphanPill?.textContent).toBe('[1]');
    expect(orphanPill?.getAttribute('title')).toContain('[1]');
    expect(orphanPill?.getAttribute('aria-label')).toContain('[1]');
    expect(container.querySelector('button')).toBeNull();
  });

  it('renders the interactive badge when the source resolves', () => {
    const { container } = renderBadge(() => ({ id: 's1', type: 'rag', title: '讲义', snippet: '' }) as never);
    expect(container.querySelector('[data-citation-anchor] button')).not.toBeNull();
    expect(container.querySelector('[data-citation-orphan]')).toBeNull();
  });

  it('leaves other citation types alone', () => {
    const { container } = renderBadge(() => null, 'memory');
    expect(container.querySelector('[data-citation-anchor] button')).not.toBeNull();
  });

  it('restores bare numeric [N] to plain text when unresolved', () => {
    const { container } = render(
      <CitationSourceContext.Provider value={() => null}>
        <CitationBadgeWithPopover citationType="rag" citationIndex={2} bareNumeric />
      </CitationSourceContext.Provider>,
    );
    expect(container.textContent).toBe('[2]');
    expect(container.querySelector('[data-citation-orphan]')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });
});
