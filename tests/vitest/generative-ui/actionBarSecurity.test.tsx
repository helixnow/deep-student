import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { ActionBarBlock } from '@/features/generative-ui/components/ActionBarBlock';
import { resolveEffectiveRiskLevel } from '@/features/generative-ui/actions';

describe('resolveEffectiveRiskLevel', () => {
  it('uses handler risk when higher than model', () => {
    expect(resolveEffectiveRiskLevel('low', 'high')).toBe('high');
  });

  it('uses model risk when higher than handler', () => {
    expect(resolveEffectiveRiskLevel('high', 'low')).toBe('high');
  });
});

describe('ActionBarBlock security', () => {
  it('opens alert dialog for high effective risk from handler', async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    render(
      <ActionBarBlock
        actions={[{ id: 'delete-all', label: '删除全部', riskLevel: 'low' }]}
        actionHandlers={{
          'delete-all': { id: 'delete-all', label: '删除全部', riskLevel: 'high', handler },
        }}
      />,
    );
    await user.click(screen.getByRole('button', { name: '删除全部' }));
    expect(screen.getByText('确认：删除全部')).toBeInTheDocument();
    expect(handler).not.toHaveBeenCalled();
  });
});
