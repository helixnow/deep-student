import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ModelMentionChip } from '@/chat-v2/components/input-bar/ModelMentionChip';

describe('ModelMentionChip', () => {
  it('keeps the main label for human-readable names containing slash descriptors', () => {
    render(
      <ModelMentionChip
        model={{
          id: 'builtin-qwen3.5-plus',
          name: 'Qwen3.5 Plus (多模态/混合思考)',
          model: 'qwen3.5-plus',
        }}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.getByText('Qwen3.5 Plus')).toBeInTheDocument();
    expect(screen.queryByText(/混合思考/)).not.toBeInTheDocument();
  });

  it('still extracts the last segment for pure model path labels', () => {
    render(
      <ModelMentionChip
        model={{
          id: 'sf-qwen',
          name: 'SiliconFlow - Qwen/Qwen3-8B',
          model: 'Qwen/Qwen3-8B',
        }}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.getByText('Qwen3-8B')).toBeInTheDocument();
  });
});
