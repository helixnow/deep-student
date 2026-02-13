/**
 * Chat V2 - RagBlock 单元测试
 *
 * 测试要点：
 * - 应该渲染来源列表
 * - 应该显示 pending 状态时的加载中 UI
 * - 应该显示错误消息
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import type { Block } from '@/chat-v2/core/types';
import type { RagBlockData } from '@/chat-v2/plugins/blocks/components/types';

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'blocks.rag.title': 'Document RAG',
        'blocks.rag.searching': 'Searching...',
        'blocks.rag.loading': 'Searching documents...',
        'blocks.rag.loadingDocs': 'Searching related documents...',
        'blocks.rag.error': 'Search failed',
        'blocks.rag.errorMessage': 'Document search failed, please retry',
        'blocks.rag.noResults': 'No documents found',
        'blocks.rag.stats': `Showing ${params?.shown} / ${params?.total} results`,
        'blocks.rag.statsSimple': `${params?.count} results`,
        'blocks.retrieval.sourcesCount': 'sources',
        'blocks.retrieval.showMore': `Show more (${params?.count})`,
        'blocks.retrieval.showLess': 'Show less',
        'blocks.retrieval.sourceTypes.rag': 'Document RAG',
      };
      return translations[key] || key;
    },
  }),
}));

// 导入组件（需要在 mock 之后）
import { RagBlock } from '@/chat-v2/plugins/blocks/rag';
import { blockRegistry } from '@/chat-v2/registry';

// ============================================================================
// 测试数据
// ============================================================================

function createRagBlock(overrides?: Partial<Block>): Block {
  return {
    id: 'rag-block-1',
    type: 'rag',
    status: 'pending',
    messageId: 'msg-1',
    ...overrides,
  };
}

function createRagBlockData(overrides?: Partial<RagBlockData>): RagBlockData {
  return {
    sources: [
      {
        id: 'source-1',
        type: 'rag',
        title: 'Test Document 1',
        snippet: 'This is a test document snippet.',
        url: 'https://example.com/doc1',
        score: 0.95,
      },
      {
        id: 'source-2',
        type: 'rag',
        title: 'Test Document 2',
        snippet: 'Another document snippet here.',
        score: 0.85,
      },
    ],
    query: 'test query',
    totalResults: 2,
    ...overrides,
  };
}

// ============================================================================
// 测试
// ============================================================================

describe('RagBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should be registered in blockRegistry', async () => {
    // 导入触发注册
    await import('@/chat-v2/plugins/blocks/rag');
    
    expect(blockRegistry.has('rag')).toBe(true);
    const plugin = blockRegistry.get('rag');
    expect(plugin?.type).toBe('rag');
    expect(plugin?.onAbort).toBe('mark-error');
  });

  describe('pending state', () => {
    it('should show loading state when pending', () => {
      const block = createRagBlock({ status: 'pending' });

      render(<RagBlock block={block} />);

      expect(screen.getByText('Document RAG')).toBeInTheDocument();
      expect(screen.getAllByText('Searching...').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('Searching related documents...')).toBeInTheDocument();
    });

    it('should show loading state when streaming', () => {
      const block = createRagBlock({ status: 'running' });

      render(<RagBlock block={block} isStreaming={true} />);

      expect(screen.getAllByText('Searching...').length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('error state', () => {
    it('should show error message on error', () => {
      const block = createRagBlock({
        status: 'error',
        error: 'Network error occurred',
      });

      render(<RagBlock block={block} />);

      expect(screen.getByText('Search failed')).toBeInTheDocument();
      expect(screen.getByText('Network error occurred')).toBeInTheDocument();
    });

    it('should show default error message when no error provided', () => {
      const block = createRagBlock({ status: 'error' });

      render(<RagBlock block={block} />);

      expect(screen.getByText('Document search failed, please retry')).toBeInTheDocument();
    });
  });

  describe('success state', () => {
    it('should render source list', () => {
      const blockData = createRagBlockData();
      const block = createRagBlock({
        status: 'success',
        toolOutput: blockData,
      });

      render(<RagBlock block={block} />);

      // 验证标题（可能有多个 Document RAG 文本，使用 getAllByText）
      const ragTexts = screen.getAllByText('Document RAG');
      expect(ragTexts.length).toBeGreaterThanOrEqual(1);
      
      // 验证来源数量
      expect(screen.getByText('2 results')).toBeInTheDocument();
      
      // 验证来源卡片内容
      expect(screen.getByText('Test Document 1')).toBeInTheDocument();
      expect(screen.getByText('Test Document 2')).toBeInTheDocument();
    });

    it('should show query when provided', () => {
      const blockData = createRagBlockData({ query: 'my search query' });
      const block = createRagBlock({
        status: 'success',
        toolOutput: blockData,
      });

      render(<RagBlock block={block} />);

      expect(screen.getByText('my search query')).toBeInTheDocument();
    });

    it('should show no results message when sources is empty', () => {
      const blockData = createRagBlockData({ sources: [], totalResults: 0 });
      const block = createRagBlock({
        status: 'success',
        toolOutput: blockData,
      });

      render(<RagBlock block={block} />);

      expect(screen.getByText('No documents found')).toBeInTheDocument();
    });

    it('should show truncated stats when totalResults > sources.length', () => {
      const blockData = createRagBlockData({
        sources: [
          { id: '1', type: 'rag', title: 'Doc 1', snippet: 'Content' },
        ],
        totalResults: 100,
      });
      const block = createRagBlock({
        status: 'success',
        toolOutput: blockData,
      });

      render(<RagBlock block={block} />);

      expect(screen.getByText('Showing 1 / 100 results')).toBeInTheDocument();
    });
  });

  describe('accessibility', () => {
    it('should have proper heading for screen readers', () => {
      const block = createRagBlock({ status: 'pending' });

      render(<RagBlock block={block} />);

      expect(screen.getAllByText('Document RAG').length).toBeGreaterThanOrEqual(1);
    });
  });
});
