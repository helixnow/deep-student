import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listTags } = vi.hoisted(() => ({
  listTags: vi.fn(),
}));

vi.mock('@/utils/notesApi', () => ({
  NotesAPI: { listTags },
}));

import { groupTagsByPrefix, TagFilter } from '../TagFilter';

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

  it('shows the intersection hint only for multi-select', () => {
    const tags = [{ name: 'math' }, { name: 'physics' }];
    const { rerender } = render(
      <TagFilter selectedTags={['math']} onChange={vi.fn()} tags={tags} />,
    );
    expect(screen.queryByRole('note')).toBeNull();

    rerender(<TagFilter selectedTags={['math', 'physics']} onChange={vi.fn()} tags={tags} />);
    expect(screen.getByRole('note')).toHaveTextContent('交集筛选');
    expect(screen.getByRole('note')).toHaveTextContent('2');
  });

  it('groups nested a/b tags under their prefix and toggles the full tag name', () => {
    const onChange = vi.fn();
    render(
      <TagFilter
        selectedTags={[]}
        onChange={onChange}
        tags={[
          { name: 'plain' },
          { name: 'math/algebra', count: 2 },
          { name: 'math/geometry' },
        ]}
      />,
    );

    expect(screen.getByText('math/')).toBeInTheDocument();
    const algebra = screen.getByRole('button', { name: 'math/algebra' });
    expect(algebra).toHaveTextContent('algebra');
    fireEvent.click(algebra);
    expect(onChange).toHaveBeenCalledWith(['math/algebra']);
  });
});

describe('groupTagsByPrefix', () => {
  it('keeps flat tags first and buckets nested tags by first segment', () => {
    const groups = groupTagsByPrefix([
      { name: 'flat' },
      { name: 'a/x' },
      { name: 'a/y' },
      { name: 'b/only' },
      { name: 'trailing/' },
    ]);

    expect(groups[0]).toEqual({
      prefix: null,
      // 单个 b/only 与畸形 trailing/ 并入平铺组
      tags: [{ name: 'flat' }, { name: 'trailing/' }, { name: 'b/only' }],
    });
    expect(groups[1]).toEqual({
      prefix: 'a',
      tags: [{ name: 'a/x' }, { name: 'a/y' }],
    });
    expect(groups).toHaveLength(2);
  });

  it('keeps a standalone nested tag as its own group when no flat group exists', () => {
    expect(groupTagsByPrefix([{ name: 'a/x' }])).toEqual([
      { prefix: 'a', tags: [{ name: 'a/x' }] },
    ]);
  });
});
