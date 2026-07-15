import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DstuNode } from '@/dstu/types';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock('@/dstu', () => ({
  dstu: { get: mocks.get },
}));

vi.mock('@/shared/result', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/result')>();
  return { ...actual, reportError: vi.fn() };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string) => key === 'error.resourceTypeMismatch' ? '资源类型不匹配' : key,
  }),
}));

vi.mock('@/features/learning-hub/apps/views/NoteContentView', () => ({
  __esModule: true,
  default: ({ node }: { node: DstuNode }) => <div data-testid="note-view">{node.name}</div>,
}));

import UnifiedAppPanel from '@/features/learning-hub/apps/UnifiedAppPanel';

function node(overrides: Partial<DstuNode> = {}): DstuNode {
  return {
    id: 'note_1',
    sourceId: 'note_1',
    path: '/folder/note_1',
    name: 'Note one',
    type: 'note',
    size: 10,
    createdAt: 1,
    updatedAt: 2,
    previewType: 'markdown',
    metadata: {},
    ...overrides,
  };
}

describe('UnifiedAppPanel workbench identity', () => {
  beforeEach(() => {
    mocks.get.mockReset();
  });

  afterEach(() => cleanup());

  it('strictType 拒绝在错误应用壳中渲染另一资源类型', async () => {
    mocks.get.mockResolvedValue({ ok: true, value: node() });

    render(
      <UnifiedAppPanel
        type="translation"
        resourceId="note_1"
        dstuPath="/folder/note_1"
        strictType
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('资源类型不匹配');
    expect(screen.queryByTestId('note-view')).toBeNull();
  });

  it('strictType 拒绝 folder 等非内容节点', async () => {
    mocks.get.mockResolvedValue({
      ok: true,
      value: node({ id: 'folder_1', sourceId: 'folder_1', type: 'folder', name: 'Folder' }),
    });

    render(
      <UnifiedAppPanel
        type="note"
        resourceId="folder_1"
        dstuPath="/folder_1"
        strictType
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('资源类型不匹配');
    expect(screen.queryByTestId('note-view')).toBeNull();
  });

  it('同一 ID 的 dstuPath 变化会重新获取节点并更新标题', async () => {
    mocks.get
      .mockResolvedValueOnce({ ok: true, value: node({ name: 'Before move' }) })
      .mockResolvedValueOnce({ ok: true, value: node({ name: 'After move', path: '/b/note_1' }) });
    const onTitleChange = vi.fn();
    const { rerender } = render(
      <UnifiedAppPanel
        type="note"
        resourceId="note_1"
        dstuPath="/a/note_1"
        onTitleChange={onTitleChange}
      />,
    );

    expect(await screen.findByText('Before move')).toBeTruthy();
    rerender(
      <UnifiedAppPanel
        type="note"
        resourceId="note_1"
        dstuPath="/b/note_1"
        onTitleChange={onTitleChange}
      />,
    );

    expect(await screen.findByText('After move')).toBeTruthy();
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    expect(onTitleChange).toHaveBeenLastCalledWith('After move');
  });
});
