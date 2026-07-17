import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listTags } = vi.hoisted(() => ({
  listTags: vi.fn(),
}));

vi.mock('@/utils/notesApi', () => ({
  NotesAPI: { listTags },
}));

import { TagFilter } from '../TagFilter';

describe('TagFilter', () => {
  beforeEach(() => {
    listTags.mockReset();
    listTags.mockResolvedValue(['math', 'physics']);
  });

  it('toggles selection and clears all chips', async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <TagFilter
        selectedTags={[]}
        onChange={onChange}
        tags={[
          { name: 'math', count: 3 },
          { name: 'physics', count: 1 },
        ]}
      />,
    );

    expect(screen.getByText('3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /math/i }));
    expect(onChange).toHaveBeenCalledWith(['math']);

    rerender(
      <TagFilter
        selectedTags={['math']}
        onChange={onChange}
        tags={[
          { name: 'math', count: 3 },
          { name: 'physics', count: 1 },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /math/i }));
    expect(onChange).toHaveBeenLastCalledWith([]);

    fireEvent.click(screen.getByRole('button', { name: '清空' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('loads tags via useNoteTags when tags prop is omitted', async () => {
    render(<TagFilter selectedTags={[]} onChange={vi.fn()} />);
    await waitFor(() => expect(listTags).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: 'math' })).toBeInTheDocument();
  });

  it('hides internal metadata tags returned by the notes API', async () => {
    listTags.mockResolvedValue(['math', '_system', '_purpose:systemic', 'daily_log']);
    render(<TagFilter selectedTags={[]} onChange={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'math' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '_system' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'daily_log' })).not.toBeInTheDocument();
  });
});
