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
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import type { Block } from '@/features/chat/core/types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
import { invoke } from '@tauri-apps/api/core';

// Mock react-i18next
// - 缺失词条时必须尊重 defaultValue（getReadableToolName 用 defaultValue: ''
//   探测词条是否存在，返回 key 会把 tools.* 泄漏成显示名）
// - t.i18n 固定英文，避免真实 i18n 单例默认中文时人性化兜底输出中文词根
vi.mock('react-i18next', () => ({
  useTranslation: () => {
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
      'blocks.ink.openArtifact': 'Open artifact',
      'blocks.ink.openDocument': 'Open document',
      'blocks.ink.undo': 'Undo',
      'blocks.ink.undoing': 'Undoing',
      'labels.skill': 'Skill',
    };
    const t = (key: string, params?: Record<string, unknown>) => {
      if (key in translations) return translations[key];
      if (params && 'defaultValue' in params) return String(params.defaultValue);
      return key;
    };
    (t as unknown as { i18n: { language: string; resolvedLanguage: string } }).i18n = {
      language: 'en-US',
      resolvedLanguage: 'en-US',
    };
    return { t, i18n: { language: 'en-US' } };
  },
  // Some modules initialize i18n in test environment and expect this export.
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

// 导入 block module（触发自动注册）
// 注意：不要导入 blocks/index（会引入 Tauri-only 依赖，导致 Vitest 环境无法解析）
import { McpToolBlockComponent } from '@/features/chat/plugins/blocks/mcpTool';
import { blockRegistry } from '@/features/chat/registry';

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

      // 工具名称应该显示（带人性化格式化）
      expect(screen.getByText('Execute Code')).toBeInTheDocument();
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

    it('should render loaded skill names for load_skills output', () => {
      const block = createMcpToolBlock({
        status: 'success',
        toolName: 'load_skills',
        toolInput: { skills: ['tutor-mode', 'learning-resource'] },
        toolOutput: {
          status: 'success',
          loaded_skill_ids: ['ask-user', 'deep-student', 'knowledge-retrieval'],
          loaded_tool_names: ['builtin-ask_user', 'builtin-note_create'],
          message: 'Skills loaded successfully.',
        },
      });

      render(<McpToolBlockComponent block={block} />);

      expect(screen.getByText('ask-user')).toBeInTheDocument();
      expect(screen.getByText('deep-student')).toBeInTheDocument();
      expect(screen.getByText('knowledge-retrieval')).toBeInTheDocument();
    });

    it('should render loaded skill names for nested load_skills output', () => {
      const block = createMcpToolBlock({
        status: 'success',
        toolName: 'load_skills',
        toolInput: { skills: ['vfs-memory'] },
        toolOutput: {
          result: {
            status: 'success',
            loaded_skill_ids: ['vfs-memory'],
            loaded_tool_names: ['builtin-memory_delete', 'builtin-memory_search'],
            message: 'Skills loaded successfully.',
          },
        },
      });

      render(<McpToolBlockComponent block={block} />);

      expect(screen.getByText('vfs-memory')).toBeInTheDocument();
      // 工具徽标现在渲染可读名（来源前缀 + 人性化短名），原始注册名保留在 title 上
      expect(screen.getByTitle('builtin-memory_delete')).toBeInTheDocument();
      expect(screen.getByText('Skill · Memory Delete')).toBeInTheDocument();
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

describe('Ink render tool result card', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const artifactRef = {
    artifactId: 'artifact-2',
    renderId: 'render-2',
    sessionId: 'sess_window_test',
    toolCallId: 'call-2',
    roundLastToolCallId: 'call-last-2',
    documentId: 'doc-1',
    pageId: 'page-2',
    revision: 'r_7',
    blobHash: 'a'.repeat(64),
    resourceId: 'res_artifact_2',
    contentHash: 'b'.repeat(64),
    mimeType: 'image/png',
    widthPx: 640,
    heightPx: 480,
  };
  const output = {
    status: 'success',
    document_id: 'doc-1',
    revision: 'r_7',
    operation_id: 'op-1',
    pages: [{
      page_id: 'page-2',
      artifact: {
        artifact_id: 'artifact-2',
        page_id: 'page-2',
        file_id: 'file_artifact_2',
        resource_id: 'res_artifact_2',
      },
    }],
  };

  it('renders ink_render metadata from the real snake_case tool output and typed refs', () => {
    const card = blockRegistry.get('mcp_tool');
    expect(card?.component).toBe(McpToolBlockComponent);
    render(<McpToolBlockComponent block={createMcpToolBlock({
      id: 'blk-ink',
      type: 'mcp_tool',
      status: 'success',
      toolName: 'builtin-ink_render',
      toolOutput: output,
      inkArtifacts: [artifactRef],
    })} />);

    expect(screen.getByTestId('ink-document-id')).toHaveTextContent('doc-1');
    expect(screen.getByTestId('ink-page-id')).toHaveTextContent('page-2');
    expect(screen.getByTestId('ink-artifact-resource')).toHaveTextContent('file_artifact_2');
    expect(screen.getByRole('button', { name: /open artifact/i })).toBeInTheDocument();
    expect(blockRegistry.has('mcp_tool')).toBe(true);
    expect(screen.queryByText(/<script>/i)).not.toBeInTheDocument();
  });

  it('opens an ink create/get document by its stable document ID', () => {
    const onPreview = vi.fn();
    window.addEventListener('CHAT_OPEN_ATTACHMENT_PREVIEW', onPreview);
    render(<McpToolBlockComponent block={createMcpToolBlock({
      id: 'blk-ink-created',
      type: 'mcp_tool',
      status: 'success',
      toolName: 'builtin-ink_create',
      toolOutput: {
        status: 'success',
        document_id: 'doc_123stable',
        revision: 'r_3',
        pages: [{ page_id: 'page_1' }],
      },
    })} />);

    fireEvent.click(screen.getByRole('button', { name: /open document/i }));
    expect(onPreview).toHaveBeenCalledWith(expect.objectContaining({
      detail: { id: 'doc_123stable', type: 'file', title: 'doc_123stable' },
    }));
    window.removeEventListener('CHAT_OPEN_ATTACHMENT_PREVIEW', onPreview);
  });

  it('routes all six exact builtin tool names through the Ink card', () => {
    for (const toolName of [
      'ink_prepare', 'builtin-ink_prepare',
      'ink_create', 'builtin-ink_create',
      'ink_get', 'builtin-ink_get',
      'ink_render', 'builtin-ink_render',
      'ink_apply_ops', 'builtin-ink_apply_ops',
      'ink_export', 'builtin-ink_export',
    ]) {
      const { unmount } = render(<McpToolBlockComponent block={createMcpToolBlock({
        id: `blk-${toolName}`,
        type: 'mcp_tool',
        status: 'success',
        toolName,
        toolOutput: output,
        inkArtifacts: [artifactRef],
      })} />);
      expect(screen.getByTestId('ink-tool-output-card')).toBeInTheDocument();
      unmount();
    }
  });

  it('does not claim an external MCP tool whose name resembles an ink tool', () => {
    render(<McpToolBlockComponent block={createMcpToolBlock({
      id: 'blk-mcp-ink-collision',
      type: 'mcp_tool',
      status: 'success',
      toolName: 'mcp_ink_render',
      toolOutput: { ...output, pages: [] },
    })} />);

    expect(screen.queryByTestId('ink-tool-output-card')).not.toBeInTheDocument();
    expect(screen.getByText('Output Result')).toBeInTheDocument();
  });

  it('shows structured errors without offering undo for non-undoable render output', () => {
    render(<McpToolBlockComponent block={createMcpToolBlock({
      id: 'blk-ink-error',
      type: 'mcp_tool',
      status: 'error',
      messageId: 'msg-ink',
      toolName: 'builtin-ink_render',
      toolOutput: {
        status: 'error',
        code: 'INK_RENDER_FAILED',
        message: 'Render failed',
        hint: 'Retry after refresh',
      },
    })} store={{ getState: () => ({ sessionId: 'sess_window_test' }) } as never} />);

    expect(screen.getByTestId('ink-error-code')).toHaveTextContent('INK_RENDER_FAILED');
    expect(screen.getByTestId('ink-error-message')).toHaveTextContent('Render failed');
    expect(screen.getByTestId('ink-error-hint')).toHaveTextContent('Retry after refresh');
    expect(screen.queryByRole('button', { name: /undo/i })).not.toBeInTheDocument();
  });

  it('allows undo only for a trusted apply receipt and uses current revision plus a fresh operation ID', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce({ revision: 'r_current' } as never)
      .mockResolvedValueOnce({} as never);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('undo-op-fresh');
    const applyOutput = {
      status: 'committed',
      document_id: 'doc-1',
      revision: 'r_apply',
      operation_id: 'apply-op-1',
      undo_available: true,
      affected_page_ids: ['page-2'],
    };
    render(<McpToolBlockComponent block={createMcpToolBlock({
      id: 'blk-ink-apply',
      type: 'mcp_tool',
      status: 'success',
      messageId: 'msg-ink',
      toolName: 'builtin-ink_apply_ops',
      toolOutput: applyOutput,
    })} store={{ getState: () => ({ sessionId: 'sess_window_test' }) } as never} />);

    fireEvent.click(screen.getByRole('button', { name: /undo/i }));
    await waitFor(() => expect(invoke).toHaveBeenNthCalledWith(1, 'vfs_ink_get', {
      request: { document_id: 'doc-1' },
    }));
    await waitFor(() => expect(invoke).toHaveBeenNthCalledWith(2, 'vfs_ink_undo_tool_operation', {
      sessionId: 'sess_window_test',
      messageId: 'msg-ink',
      blockId: 'blk-ink-apply',
      expectedRevision: 'r_current',
      operationId: 'undo-op-fresh',
    }));
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
    await import('@/features/chat/plugins/blocks/imageGen');
    expect(blockRegistry.has('image_gen')).toBe(true);
    const plugin = blockRegistry.get('image_gen');
    expect(plugin?.type).toBe('image_gen');
    expect(plugin?.onAbort).toBe('mark-error');
  });
});
