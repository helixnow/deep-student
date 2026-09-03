/**
 * 聊天导图引用回归（mm_ 当前版本 / mv_ 版本快照）：
 * - mm_ 引用走 getMindMap + getMindMapContent，并订阅 dstu 更新
 * - mv_ 引用走 getMindMapVersion + getMindMapVersionContent（不可变，不订阅）
 * - 「打开」按钮：mm_ 直接导航到自身；mv_ 导航到父导图
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => {
  // t 必须是稳定引用：MindMapEmbed 的加载 effect 以 t 为依赖，
  // 每次渲染返回新函数会造成无限 reload 循环
  const t = (key: string, params?: Record<string, unknown>) =>
    params ? `${key} ${Object.values(params).join(' ')}` : key;
  const translation = { t };
  return {
    useTranslation: () => translation,
    // 传导链会加载 src/i18n.ts（真实 init），提供最小 3rdParty 插件面
    initReactI18next: { type: '3rdParty', init: () => undefined },
  };
});

// 只做加载态/按钮回归，不渲染真实画布（jsdom 无布局能力）；
// 同时 mock 掉节点/边组件与注册表，避免拉起整棵画布组件依赖图（heap 压力）
vi.mock('@xyflow/react', () => ({
  ReactFlow: () => <div data-testid="embed-flow" />,
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useReactFlow: () => ({ fitView: vi.fn(), zoomIn: vi.fn(), zoomOut: vi.fn() }),
}));
vi.mock('@/features/mindmap/components/mindmap/nodes', () => ({ nodeTypes: {} }));
vi.mock('@/features/mindmap/components/mindmap/edges', () => ({ edgeTypes: {} }));
vi.mock('@/features/mindmap/init', () => ({ ensureInitialized: () => undefined }));
vi.mock('@/features/mindmap/registry', () => ({
  LayoutRegistry: { get: () => null },
  StyleRegistry: { get: () => null, getDefault: () => null },
}));

const { apiMocks, watchMock } = vi.hoisted(() => ({
  apiMocks: {
    getMindMap: vi.fn(),
    getMindMapContent: vi.fn(),
    getMindMapVersion: vi.fn(),
    getMindMapVersionContent: vi.fn(),
  },
  watchMock: vi.fn(() => () => undefined),
}));

vi.mock('@/features/mindmap/api', () => apiMocks);
vi.mock('@/dstu', () => ({ dstu: { watch: watchMock } }));

import { MindMapEmbed } from '@/features/mindmap/components/mindmap/MindMapEmbed';

function documentJson(rootText: string): string {
  return JSON.stringify({
    version: '1.0',
    root: { id: 'root', text: rootText, children: [{ id: 'c1', text: 'child', children: [] }] },
    meta: { createdAt: '2026-01-01T00:00:00.000Z' },
  });
}

beforeEach(() => {
  apiMocks.getMindMap.mockReset().mockResolvedValue({
    id: 'mm_123',
    resourceId: 'res_1',
    title: '章节导图',
    isFavorite: false,
    defaultView: 'mindmap',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  apiMocks.getMindMapContent.mockReset().mockResolvedValue(documentJson('章节导图'));
  apiMocks.getMindMapVersion.mockReset().mockResolvedValue({
    versionId: 'mv_abc',
    mindmapId: 'mm_parent',
    resourceId: 'res_2',
    title: '历史版本',
    source: 'chat_update',
    createdAt: '2026-01-02T00:00:00.000Z',
  });
  apiMocks.getMindMapVersionContent.mockReset().mockResolvedValue(documentJson('历史版本'));
  watchMock.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('MindMapEmbed mm_ reference (current version)', () => {
  it('loads via getMindMap/getMindMapContent, subscribes updates, and opens itself', async () => {
    render(<MindMapEmbed mindmapId="mm_123" />);

    await screen.findByTestId('embed-flow');
    expect(apiMocks.getMindMap).toHaveBeenCalledWith('mm_123');
    expect(apiMocks.getMindMapContent).toHaveBeenCalledWith('mm_123');
    expect(apiMocks.getMindMapVersion).not.toHaveBeenCalled();
    // 当前版本引用：订阅 dstu 更新（编辑器改动时静默刷新聊天卡片）
    expect(watchMock).toHaveBeenCalled();
    expect(screen.getByText('章节导图')).toBeInTheDocument();

    const navSpy = vi.fn();
    window.addEventListener('NAVIGATE_TO_VIEW', navSpy);
    fireEvent.click(screen.getByRole('button', { name: 'embed.openInNewWindow' }));
    window.removeEventListener('NAVIGATE_TO_VIEW', navSpy);

    expect(navSpy).toHaveBeenCalledTimes(1);
    expect((navSpy.mock.calls[0][0] as CustomEvent).detail).toEqual({
      view: 'learning-hub',
      openResource: '/mm_123',
    });
  });
});

describe('MindMapEmbed mv_ reference (version snapshot)', () => {
  it('loads via version APIs, skips the live watch, and opens the parent mind map', async () => {
    render(<MindMapEmbed versionId="mv_abc" />);

    await screen.findByTestId('embed-flow');
    expect(apiMocks.getMindMapVersion).toHaveBeenCalledWith('mv_abc');
    expect(apiMocks.getMindMapVersionContent).toHaveBeenCalledWith('mv_abc');
    expect(apiMocks.getMindMap).not.toHaveBeenCalled();
    // 版本快照不可变：不订阅 dstu 更新
    expect(watchMock).not.toHaveBeenCalled();

    const navSpy = vi.fn();
    window.addEventListener('NAVIGATE_TO_VIEW', navSpy);
    fireEvent.click(screen.getByRole('button', { name: 'embed.openInNewWindow' }));
    window.removeEventListener('NAVIGATE_TO_VIEW', navSpy);

    // mv_ 引用「打开」必须落到父导图（历史回归：曾经直接跳过）
    expect(navSpy).toHaveBeenCalledTimes(1);
    expect((navSpy.mock.calls[0][0] as CustomEvent).detail).toEqual({
      view: 'learning-hub',
      openResource: '/mm_parent',
    });
  });

  it('renders empty version content as a default root instead of an error', async () => {
    apiMocks.getMindMapVersionContent.mockResolvedValue(null);
    render(<MindMapEmbed versionId="mv_abc" />);

    await screen.findByTestId('embed-flow');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('MindMapEmbed failure handling', () => {
  it('shows the retry-able error card when the mm_ resource is missing', async () => {
    apiMocks.getMindMap.mockResolvedValue(null);
    apiMocks.getMindMapContent.mockResolvedValue(null);
    render(<MindMapEmbed mindmapId="mm_gone" />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText('embed.notFound')).toBeInTheDocument();

    // 重试按钮触发重新拉取
    apiMocks.getMindMap.mockResolvedValue({
      id: 'mm_gone',
      resourceId: 'res_3',
      title: '恢复的导图',
      isFavorite: false,
      defaultView: 'mindmap',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    apiMocks.getMindMapContent.mockResolvedValue(documentJson('恢复的导图'));
    fireEvent.click(screen.getByRole('button', { name: /shellV2\.embed\.retry/ }));
    await screen.findByTestId('embed-flow');
  });
});
