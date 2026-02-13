/**
 * Chat V2 - McpToolBlock 单元测试
 *
 * 测试要点：
 * - 应该渲染工具名称和输入
 * - 应该在 running 状态时显示进度
 * - 应该根据类型格式化输出
 * - 应该在错误状态时显示重试按钮
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import type { Block } from '@/chat-v2/core/types';

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'blocks.mcpTool.title': 'Tool Call',
        'blocks.mcpTool.unknownTool': 'Unknown Tool',
        'blocks.mcpTool.input': 'Input Parameters',
        'blocks.mcpTool.output': 'Output Result',
        'blocks.mcpTool.noOutput': 'No output',
        'blocks.mcpTool.showFullJson': 'Show full JSON',
        'blocks.mcpTool.executing': 'Executing...',
        'blocks.mcpTool.streamingOutput': 'Live Output',
        'blocks.mcpTool.executionFailed': 'Execution Failed',
        'blocks.mcpTool.unknownError': 'Unknown error',
        'blocks.mcpTool.retry': 'Retry',
        'blocks.mcpTool.status.pending': 'Pending',
        'blocks.mcpTool.status.running': 'Running',
        'blocks.mcpTool.status.success': 'Completed',
        'blocks.mcpTool.status.error': 'Failed',
      };
      return translations[key] || key;
    },
  }),
  // Some modules initialize i18n in test environment and expect this export.
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

// 导入 block module（触发自动注册）
// 注意：不要导入 blocks/index（会引入 Tauri-only 依赖，导致 Vitest 环境无法解析）
import { McpToolBlockComponent } from '@/chat-v2/plugins/blocks/mcpTool';
import { blockRegistry } from '@/chat-v2/registry';

// ============================================================================
// 测试数据
// ============================================================================

function createMcpToolBlock(overrides?: Partial<Block>): Block {
  return {
    id: 'mcp-tool-block-1',
    type: 'mcp_tool',
    status: 'pending',
    messageId: 'msg-1',
    toolName: 'read_file',
    toolInput: { path: '/test/file.txt' },
    startedAt: Date.now(),
    ...overrides,
  };
}

// ============================================================================
// 测试
// ============================================================================

describe('McpToolBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should be registered in blockRegistry', () => {
    expect(blockRegistry.has('mcp_tool')).toBe(true);
    const plugin = blockRegistry.get('mcp_tool');
    expect(plugin?.type).toBe('mcp_tool');
    expect(plugin?.onAbort).toBe('mark-error');
  });

  describe('Rendering', () => {
    it('should render tool name and input', () => {
      const block = createMcpToolBlock({
        status: 'pending',
        toolName: 'execute_code',
        toolInput: { language: 'python', code: 'print("hello")' },
      });

      render(<McpToolBlockComponent block={block} />);

      // 工具名称应该显示
      expect(screen.getByText('execute_code')).toBeInTheDocument();
    });

    it('should render unknown tool name when not provided', () => {
      const block = createMcpToolBlock({
        status: 'pending',
        toolName: undefined,
        toolInput: {},
      });

      render(<McpToolBlockComponent block={block} />);

      expect(screen.getByText('Unknown Tool')).toBeInTheDocument();
    });
  });

  describe('Status States', () => {
    it('should show progress when running', () => {
      const block = createMcpToolBlock({
        status: 'running',
        toolName: 'long_running_task',
      });

      render(<McpToolBlockComponent block={block} isStreaming />);

      // 应该显示执行中状态
      expect(screen.getByText('Running')).toBeInTheDocument();
      expect(screen.getByText('Executing...')).toBeInTheDocument();
    });

    it('should show streaming output when running with content', () => {
      const block = createMcpToolBlock({
        status: 'running',
        toolName: 'execute_code',
        content: 'Hello from stdout\nLine 2',
      });

      render(<McpToolBlockComponent block={block} isStreaming />);

      // 应该有流式输出按钮
      expect(screen.getByText('Live Output')).toBeInTheDocument();
    });

    it('should show success output', () => {
      const block = createMcpToolBlock({
        status: 'success',
        toolName: 'read_file',
        toolOutput: { content: 'File content here', size: 1024 },
        endedAt: Date.now(),
      });

      render(<McpToolBlockComponent block={block} />);

      // 应该显示完成状态
      expect(screen.getByText('Completed')).toBeInTheDocument();
      // 应该显示输出结果
      expect(screen.getByText('Output Result')).toBeInTheDocument();
    });

    it('should format output based on type (JSON)', () => {
      const jsonOutput = {
        name: 'test',
        value: 123,
        nested: { key: 'value' },
      };

      const block = createMcpToolBlock({
        status: 'success',
        toolName: 'api_call',
        toolOutput: jsonOutput,
      });

      render(<McpToolBlockComponent block={block} />);

      // JSON 输出应该被格式化显示
      expect(screen.getByText(/"name"/)).toBeInTheDocument();
    });

    it('should treat chatanki_wait timeout (block not found) as success output, not error UI', () => {
      const block = createMcpToolBlock({
        status: 'success',
        toolName: 'builtin-chatanki_wait',
        toolOutput: {
          status: 'timeout',
          ankiBlockId: 'anki_cards-block-missing',
          documentId: null,
          cardsCount: 0,
          progress: null,
          ankiConnect: null,
          error: 'Anki cards block not found: anki_cards-block-missing',
        },
      });

      render(<McpToolBlockComponent block={block} />);

      // 应该保持 tool block 自身的 success 状态，不渲染错误态 UI（retry/failed）
      expect(screen.getByText('Completed')).toBeInTheDocument();
      expect(screen.queryByText('Failed')).not.toBeInTheDocument();
      expect(screen.queryByText('Retry')).not.toBeInTheDocument();

      // 输出中应包含 timeout 信息（后端 wait 不再抛错，而是返回结构化结果）
      expect(screen.getByText(/timeout/i)).toBeInTheDocument();
    });
  });

  describe('Error State', () => {
    it('should show retry button on error', () => {
      const block = createMcpToolBlock({
        status: 'error',
        toolName: 'failing_tool',
        error: 'Connection timeout',
      });

      render(<McpToolBlockComponent block={block} />);

      // 应该显示错误状态
      expect(screen.getByText('Failed')).toBeInTheDocument();
      // 应该显示错误信息
      expect(screen.getByText('Connection timeout')).toBeInTheDocument();
      // 应该显示重试按钮
      expect(screen.getByText('Retry')).toBeInTheDocument();
    });

    it('should show unknown error message when error is not provided', () => {
      const block = createMcpToolBlock({
        status: 'error',
        toolName: 'failing_tool',
        error: undefined,
      });

      render(<McpToolBlockComponent block={block} />);

      expect(screen.getByText('Unknown error')).toBeInTheDocument();
    });
  });

  describe('Input Collapse Behavior', () => {
    it('should auto-expand input on running status', () => {
      const block = createMcpToolBlock({
        status: 'running',
        toolInput: { param1: 'value1', param2: 'value2' },
      });

      render(<McpToolBlockComponent block={block} />);

      // 在 running 状态下，输入应该自动展开
      expect(screen.getByText('Input Parameters')).toBeInTheDocument();
    });

    it('should auto-expand input on error status', () => {
      const block = createMcpToolBlock({
        status: 'error',
        error: 'Some error',
        toolInput: { param1: 'value1' },
      });

      render(<McpToolBlockComponent block={block} />);

      // 在 error 状态下，输入应该自动展开
      expect(screen.getByText('Input Parameters')).toBeInTheDocument();
    });
  });
});

// ============================================================================
// ImageGenBlock 测试（可选，放在同一文件或单独文件）
// ============================================================================

describe('ImageGenBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should be registered in blockRegistry', async () => {
    await import('@/chat-v2/plugins/blocks/imageGen');
    expect(blockRegistry.has('image_gen')).toBe(true);
    const plugin = blockRegistry.get('image_gen');
    expect(plugin?.type).toBe('image_gen');
    expect(plugin?.onAbort).toBe('mark-error');
  });
});
