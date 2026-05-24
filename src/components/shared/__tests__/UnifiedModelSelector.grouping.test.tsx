import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UnifiedModelSelector } from '../UnifiedModelSelector';

describe('UnifiedModelSelector vendor grouping', () => {
  it('renders visible vendor headers with counts in model assignment lists', () => {
    render(
      <UnifiedModelSelector
        models={[
          {
            id: 'sf-deepseek',
            name: 'SiliconFlow - DeepSeek V3',
            model: 'deepseek-ai/DeepSeek-V3',
            vendorId: 'builtin-siliconflow',
            vendorName: 'SiliconFlow',
            vendorSortOrder: 0,
          },
          {
            id: 'deepseek-reasoner',
            name: 'DeepSeek Reasoner',
            model: 'deepseek-reasoner',
            vendorId: 'builtin-deepseek',
            vendorName: 'DeepSeek',
            vendorSortOrder: 1,
            isFavorite: true,
          },
          {
            id: 'deepseek-chat',
            name: 'DeepSeek Chat',
            model: 'deepseek-chat',
            vendorId: 'builtin-deepseek',
            vendorName: 'DeepSeek',
            vendorSortOrder: 1,
          },
        ]}
        value=""
        onChange={vi.fn()}
        variant="full"
        placeholder="Select model"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Select model/i }));

    const headers = screen.getAllByTestId('model-selector-vendor-group-header');
    expect(headers).toHaveLength(2);
    expect(headers[0]).toHaveTextContent('SiliconFlow');
    expect(headers[0]).toHaveTextContent('1');
    expect(headers[1]).toHaveTextContent('DeepSeek');
    expect(headers[1]).toHaveTextContent('2');

    const deepSeekGroup = screen.getByTestId('model-selector-vendor-group-builtin-deepseek');
    const deepSeekOptions = within(deepSeekGroup).getAllByRole('button');
    expect(deepSeekOptions[0]).toHaveTextContent('deepseek-reasoner');
    expect(deepSeekOptions[1]).toHaveTextContent('deepseek-chat');
  });
});
