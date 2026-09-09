/**
 * ArtifactsPanel note/file 详情内联预览回归测试。
 *
 * 背景：产物面板 note/file 详情曾是「在应用中打开」占位死胡同（点进去看不到内容），
 * 本用例锁定修复后的行为：内联复用 UnifiedAppPanel（学习资源预览器）+ 头部保留
 * 打开完整应用入口，且 file 不再走被模式优先级压住的 openResource。
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { StoreApi } from 'zustand';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

vi.mock('@/features/learning-hub/apps/UnifiedAppPanel', () => ({
  UnifiedAppPanel: (props: { type: string; resourceId: string }) => (
    <div data-testid="unified-app-panel" data-type={props.type} data-resource-id={props.resourceId} />
  ),
}));

vi.mock('@/features/generative-ui/components/GenerativeUIPanel', () => ({
  GenerativeUIPanel: () => <div data-testid="generative-ui-panel" />,
}));

vi.mock('@/features/chat/plugins/blocks/ankiCardsBlock', () => ({
  AnkiCardsBlock: () => <div data-testid="anki-cards-block" />,
}));

import { ArtifactsPanel } from '../ArtifactsPanel';
import { clearSessionArtifacts } from '@/features/chat/core/store/artifactRegistry';
import type { ChatStore } from '@/features/chat/core/types';

const SESSION_ID = 'sess-artifacts-preview';

function createMockStore(block: Record<string, unknown>): StoreApi<ChatStore> {
  const state = {
    sessionId: SESSION_ID,
    blocks: new Map([[String(block.id), block]]),
    messageMap: new Map(),
    messageOrder: [] as string[],
    sessionMetadata: null,
  };
  return createStore<ChatStore>(() => state as unknown as ChatStore);
}

const noteBlock = {
  id: 'block-note-1',
  messageId: 'msg-1',
  type: 'mcp_tool',
  status: 'success',
  toolName: 'builtin-note_create',
  toolInput: {},
  toolOutput: { result: { note_id: 'note_1', title: '上下文机制详解' } },
  startedAt: 1,
  endedAt: 2,
};

const fileBlock = {
  id: 'block-file-1',
  messageId: 'msg-1',
  type: 'mcp_tool',
  status: 'success',
  toolName: 'builtin-docx_create',
  toolInput: {},
  toolOutput: { result: { file_id: 'file_1', file_name: '报告.docx' } },
  startedAt: 1,
  endedAt: 2,
};

async function renderNoteDetail() {
  const store = createMockStore(noteBlock);
  render(<ArtifactsPanel sessionId={SESSION_ID} store={store} onClose={() => {}} />);
  // 标题在产物列表与「变更记录」各出现一次；取列表项（DOM 在前）
  fireEvent.click((await screen.findAllByText('上下文机制详解'))[0]);
  return screen.findByTestId('unified-app-panel');
}

describe('ArtifactsPanel note/file 详情', () => {
  beforeEach(() => {
    clearSessionArtifacts(SESSION_ID);
  });

  it('note 产物详情内联渲染 UnifiedAppPanel 预览器', async () => {
    const panel = await renderNoteDetail();
    expect(panel).toHaveAttribute('data-type', 'note');
    expect(panel).toHaveAttribute('data-resource-id', 'note_1');
  });

  it('note 产物头部「在应用中打开」派发 DSTU_OPEN_NOTE', async () => {
    await renderNoteDetail();
    const listener = vi.fn();
    window.addEventListener('DSTU_OPEN_NOTE', listener);
    try {
      fireEvent.click(screen.getByRole('button', { name: '在应用中打开' }));
      expect(listener).toHaveBeenCalledTimes(1);
      expect((listener.mock.calls[0][0] as CustomEvent).detail).toMatchObject({
        noteId: 'note_1',
        source: 'artifacts_panel',
      });
    } finally {
      window.removeEventListener('DSTU_OPEN_NOTE', listener);
    }
  });

  it('file 产物头部「在应用中打开」走学习中心导航而非 openResource', async () => {
    const store = createMockStore(fileBlock);
    render(<ArtifactsPanel sessionId={SESSION_ID} store={store} onClose={() => {}} />);
    fireEvent.click((await screen.findAllByText('报告.docx'))[0]);

    const panel = await screen.findByTestId('unified-app-panel');
    expect(panel).toHaveAttribute('data-type', 'file');

    const listener = vi.fn();
    window.addEventListener('NAVIGATE_TO_VIEW', listener);
    try {
      fireEvent.click(screen.getByRole('button', { name: '在应用中打开' }));
      expect(listener).toHaveBeenCalledTimes(1);
      expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({
        view: 'learning-hub',
        openResource: '/file_1',
      });
    } finally {
      window.removeEventListener('NAVIGATE_TO_VIEW', listener);
    }
  });
});
