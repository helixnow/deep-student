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
  it('renders nothing for [知识库-N] when the message has no such source', () => {
    const { container } = renderBadge(() => null);
    expect(container.querySelector('[data-citation-anchor]')).toBeNull();
  });

  it('renders the badge when the source resolves', () => {
    const { container } = renderBadge(() => ({ id: 's1', type: 'rag', title: '讲义', snippet: '' }) as never);
    expect(container.querySelector('[data-citation-anchor] button')).not.toBeNull();
  });

  it('leaves other citation types alone', () => {
    const { container } = renderBadge(() => null, 'memory');
    expect(container.querySelector('[data-citation-anchor] button')).not.toBeNull();
  });
});
